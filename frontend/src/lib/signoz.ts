/**
 * Client for the admin logs panel. The browser NEVER talks to SigNoz
 * directly: every call below hits the same-origin gateway proxy at
 * `/api/admin/logs/*` (admin session required), and the gateway holds
 * the SIGNOZ-API-KEY server-side (see backend/source/ircfiber/web/admin/logs.d).
 * Request/response shapes are still the SigNoz v0.130 envelopes so the
 * stores keep parsing what they parse today.
 *
 * No Svelte imports -- eligible for the lib project test config
 * (node, no DOM).
 *
 * Endpoints covered (all paths are relative to the page origin):
 *   POST /api/admin/logs/query_range  -> queryRange(req)
 *
 * Service options are derived client-side from loaded rows: the
 * installed SigNoz (v0.138) no longer serves /api/v1/services, so
 * there is no services() helper.
 *
 * Live tail is polling-based (see admin/stores/logsLiveTail.ts), not a
 * SigNoz WebSocket -- there is no wsUrl helper anymore.
 *
 * SECURITY (do not change without security review):
 *   This module NEVER sets a SIGNOZ-API-KEY header. The key lives in
 *   the gateway's IRCFIBER_SIGNOZ_API_KEY env. If you are tempted to
 *   add an Authorization, x-api-key, or any other auth header here,
 *   stop. Browser-side code must never see the SigNoz key. Any change
 *   that adds such a header is a security regression and must be
 *   rejected in code review.
 */

// ───────────────────────────────────────────────────────────────────────────
// Error class
// ───────────────────────────────────────────────────────────────────────────

/**
 * Thrown for every failure path of the SigNoz wrapper:
 *   - status === 0 means the request never reached the server (network,
 *     DNS, AbortController timeout, or fetch's own throw).
 *   - status !== 0 mirrors the HTTP status SigNoz returned. Use the
 *     `status` field for branches (e.g. toastError on 401/500), not the
 *     message (which is human-localised text).
 */
export class ApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Request plumbing
// ───────────────────────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 15_000;

export interface RequestOptions {
  /** Default 15_000 ms. Set to 0 to disable the timeout entirely. */
  timeoutMs?: number;
  /** Forwarded to fetch. Aborting this signal also aborts the underlying
   *  request. Composes with the internal timeout abort. */
  signal?: AbortSignal;
  /** Optional query string merged into the path. */
  query?: Readonly<Record<string, string | number | boolean>>;
}

function appendQuery(
  path: string,
  query: RequestOptions['query'],
): string {
  if (!query) return path;
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    params.set(k, String(v));
  }
  const qs = params.toString();
  if (!qs) return path;
  return path + (path.includes('?') ? '&' : '?') + qs;
}

/**
 * Pull a human-friendly error string out of a SigNoz failure body. SigNoz
 * returns `{error: "<msg>"}` for most v1/v5 failures; anything else falls
 * through to the supplied fallback (typically `res.statusText`).
 */
function extractErrorMessage(raw: string, fallback: string): string {
  if (!raw) return fallback;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      const err = (parsed as { error?: unknown }).error;
      if (typeof err === 'string' && err.length > 0) return err;
    }
  } catch {
    // Body wasn't JSON; fall through to the statusText fallback.
  }
  return fallback;
}

async function request<T>(
  method: 'GET' | 'POST',
  path: string,
  opts: RequestOptions & { body?: unknown } = {},
): Promise<T> {
  const url = appendQuery(path, opts.query);

  // Headers are deliberately minimal: NO auth. The gateway holds the
  // SIGNOZ-API-KEY server-side. Accept: application/json so non-JSON
  // error pages fall through to statusText instead of being parsed as
  // something they aren't.
  const headers: Record<string, string> = {
    Accept: 'application/json',
  };
  let payload: string | undefined;
  if (method === 'POST' && opts.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(opts.body);
  }

  // Internal abort: bound the request so a hung SigNoz doesn't pin a
  // browser tab. Composes with caller-supplied `signal`.
  const ac = new AbortController();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timer =
    timeoutMs > 0
      ? setTimeout(
          () => ac.abort(new DOMException('Timeout', 'TimeoutError')),
          timeoutMs,
        )
      : null;
  if (opts.signal) {
    if (opts.signal.aborted) ac.abort(opts.signal.reason);
    else
      opts.signal.addEventListener('abort', () =>
        ac.abort(opts.signal!.reason),
      );
  }

  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: payload,
      signal: ac.signal,
      // Same-origin: the gateway proxy endpoints require the admin
      // session cookie (requireAuth). The old Caddy SigNoz path needed
      // no cookies because Caddy injected the key; the gateway path
      // authenticates the operator instead.
      credentials: 'same-origin',
    });
  } catch (e) {
    if (timer) clearTimeout(timer);
    // fetch's own abort path lands here with `name === 'AbortError'` unless
    // we tagged it as TimeoutError above. We only translate the timeout
    // case; user-driven aborts propagate as-is with their original message.
    if (e instanceof Error && e.name === 'TimeoutError') {
      throw new ApiError('Request timed out', 0);
    }
    throw new ApiError((e as Error)?.message || 'Network error', 0);
  }
  if (timer) clearTimeout(timer);

  const raw = await res.text();
  if (!res.ok) {
    const msg = extractErrorMessage(
      raw,
      res.statusText || `HTTP ${res.status}`,
    );
    throw new ApiError(msg, res.status);
  }
  if (!raw) return undefined as unknown as T;
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new ApiError('Invalid JSON response', res.status);
  }
}

async function get<T>(path: string, opts?: RequestOptions): Promise<T> {
  return request<T>('GET', path, opts);
}

async function post<T>(
  path: string,
  body: unknown,
  opts?: RequestOptions,
): Promise<T> {
  return request<T>('POST', path, { ...(opts ?? {}), body });
}

// ───────────────────────────────────────────────────────────────────────────
// Response shapes (typed for the parts we use; unknown leaves avoid `any`)
// Documented per SigNoz v0.130 -- increase confidence by snapshotting the
// live contract if v0.131 changes the envelope.
// ───────────────────────────────────────────────────────────────────────────



/** Per-query result inside a /api/v5/query_range response. Either `series`
 *  (time-series queries) or `list` (table/log queries) is populated;
 *  both are typed `unknown[]` because the per-element shape varies by
 *  aggregations/columns selected. Narrow at the call site. */
export interface QueryRangeResult {
  queryName: string;
  series?: readonly unknown[];
  list?: readonly unknown[];
  /** Free-form query-specific payload (panelType-dependent). */
  readonly [extra: string]: unknown;
}

/** POST /api/v5/query_range envelope. `data` is keyed by the query's
 *  `spec.name` (the "queryName"); each entry is one query's output. */
export interface QueryRangeResponse {
  status?: string;
  data?: Readonly<Record<string, QueryRangeResult>>;
  /** Future SigNoz envelope keys we don't depend on today. */
  readonly [extra: string]: unknown;
}

/** Minimum typed shape for the `compositeQuery` envelope. Per-query specs
 *  (`queries[]`) are left untyped at this level because `builder_query`,
 *  `promql`, and `clickhouse_sql` diverge structurally -- maintain a
 *  parallel type tree at the call site if you need narrow access. */
export interface CompositeQuery {
  queryType: 'builder' | 'promql' | 'clickhouse_sql';
  panelType?: 'graph' | 'list' | 'table' | 'value';
  queries: readonly object[];
  unit?: string;
  formula?: unknown;
}

export interface QueryRangeRequest {
  /** Unix milliseconds, inclusive. */
  start: number;
  /** Unix milliseconds, exclusive. */
  end: number;
  compositeQuery: CompositeQuery;
  requestType?: 'scalar' | 'time_series' | 'distribution' | 'raw';
  schemaVersion?: string;
  stepInterval?: number;
  unit?: string;
  variables?: Readonly<Record<string, unknown>>;
}

// ───────────────────────────────────────────────────────────────────────────
// Public API
// ───────────────────────────────────────────────────────────────────────────

/** POST query_range via the gateway proxy -- runs a SigNoz v5 builder query. */
export function queryRange(
  req: QueryRangeRequest,
  opts?: RequestOptions,
): Promise<QueryRangeResponse> {
  return post<QueryRangeResponse>('/api/admin/logs/query_range', req, opts);
}


