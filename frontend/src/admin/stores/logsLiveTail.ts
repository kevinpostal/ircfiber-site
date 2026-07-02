/**
 * logsLiveTail -- WebSocket-driven live-tail of SigNoz logs.
 *
 * Single WebSocket connection to `signoz.wsUrl(orgId)` (which returns
 * the Caddy-routed path `/signoz/ws/logs/v5/{orgId}`). The orgId is
 * discovered lazily on first connect via `currentUser()` (GET
 * /api/v1/user); a failed discovery falls back to the literal string
 * "default" with a `toastWarn` so the admin sees the degradation.
 *
 * Status state machine (see `LiveTailStatus`):
 *
 *     idle ──startLiveTail──> connecting ──onopen──> open
 *                                              │
 *                                              ├──onclose──> reconnecting ──timer──> connecting
 *                                              │                  │
 *                                              │                  └──10 attempts──> closed
 *                                              │
 *                                              └──stopLiveTail──> idle
 *
 * Backoff: 1s, 2s, 4s, 8s, 16s, 30s (capped) with +/-20 percent jitter.
 * A 1s floor is applied after the jitter math so the test driver is
 * never waiting on a sub-second schedule that's noisier than the
 * production minimum. Reconnect timers use the real `setTimeout`
 * so that `vi.useFakeTimers()` in the test suite can advance through
 * 30 backoff cycles deterministically.
 *
 * Failure cap: 10 consecutive reconnect attempts after the LAST
 * successful `open` flips status to `closed` permanently (no further
 * timers scheduled). `startLiveTail()` from `closed` is allowed --
 * it resets the attempt counter and retries.
 *
* Wire data: incoming `MessageEvent.data` is parsed as JSON. The
 *  payload may be either a single object OR an array of objects; rows
 *  that fail the `LogRow` contract are silently dropped. Throwing
 *  from the message handler would tear down the WS via the error
 *  path, which is exactly the failure mode we DON'T want during a
 *  live stream -- so we trade visibility for resilience.
 */
import { get, writable, type Writable } from 'svelte/store';
import { currentUser, wsUrl } from '../../lib/signoz';
import {
  logs,
  logsLive,
  wsLastAttemptAt,
  wsReady,
  type LogRow,
} from './logsStore';
import { toastWarn } from './ui';

// --- Constants -------------------------------------------------------------

/** Max consecutive reconnect attempts before declaring permanent failure. */
const MAX_ATTEMPTS = 10;

/** Base backoff schedule in ms: 1s, 2s, 4s, 8s, 16s, 30s. */
const BASE_DELAYS_MS: readonly number[] = [
  1_000, 2_000, 4_000, 8_000, 16_000, 30_000,
];

/** Floor applied after the jitter math to keep delays >= 1s. */
const MIN_DELAY_MS = 1_000;

/** Fallback orgId used when /api/v1/user is unreachable. */
const DEFAULT_ORG_ID = 'default';

/** Default tail filter used when `startLiveTail()` is called with no args. */
const DEFAULT_FILTER = '';

// --- Public types ----------------------------------------------------------

export type LiveTailStatus =
  | 'idle'
  | 'connecting'
  | 'open'
  | 'reconnecting'
  | 'closed';

export interface LiveTailFilter {
  /** Body CONTAINS expression forwarded as the WS `filter` query string. */
  query?: string;
  /** Severity filter (e.g. `["ERROR","WARN"]`). */
  severities?: readonly string[];
  /** Service-name filter (e.g. `["irc-fiber-engine"]`). */
  services?: readonly string[];
  /**
   * Time-range filter forwarded for context only. SigNoz live-tail ignores
   * timeRange -- the WS tail is always "now forward" and cannot rewind --
   * so the field exists to keep callers' filter shapes uniform with
   * `TimeRange`-aware query paths. The start/end/label are not serialized
   * to the WS envelope and have no effect on what rows stream back.
   */
  timeRange?: { start: number; end: number; label?: string };
}

// --- Writable stores -------------------------------------------------------

/** Live-tail connection state. */
export const liveTailStatus: Writable<LiveTailStatus> =
  writable<LiveTailStatus>('idle');

/** 1-based counter of consecutive reconnect attempts (0 when first trying
 *  or after a successful open). Useful for UI badges ("attempt 3/10"). */
export const liveTailAttempt: Writable<number> = writable<number>(0);

/** Permanent error surfaced when MAX_ATTEMPTS is reached. `null` when
 *  the connection is healthy or still retrying. */
export const liveTailError: Writable<string | null> =
  writable<string | null>(null);

// --- Internal mutable state (module-scoped) --------------------------------

/** Active WebSocket handle, or `null` when idle. */
let ws: WebSocket | null = null;

/** Pending reconnect timer handle, or `null` when not waiting. */
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

/** Current 1-based reconnect attempt counter (0 = fresh start). */
let attempt = 0;

/** Cached orgId so we don't re-fetch on every reconnect. */
let cachedOrgId: string | null = null;

// --- Helpers ---------------------------------------------------------------

/** Map the rich LiveTailStatus to the 3-value WsReadyState the toolbar
 *  badge in logsStore consumes. `'idle'` and `'connecting'` both render
 *  as `'closed'` (nothing usable yet), and `'closed'` is the literal
 *  permanent-error mirror. */
function toWsReady(s: LiveTailStatus): 'open' | 'reconnecting' | 'closed' {
  if (s === 'open') return 'open';
  if (s === 'reconnecting') return 'reconnecting';
  return 'closed';
}

/** Resolve the backoff (in ms) for the given 1-based attempt number.
 *  Caps at the last entry in `BASE_DELAYS_MS` (30s), applies +/-20%
 *  jitter, then floors at `MIN_DELAY_MS` so the schedule never drops
 *  below the documented 1s minimum. */
export function delayForAttempt(n: number): number {
  const idx = Math.min(Math.max(n - 1, 0), BASE_DELAYS_MS.length - 1);
  const base = BASE_DELAYS_MS[idx]!;
  const jittered = base * (0.8 + Math.random() * 0.4);
  return Math.max(MIN_DELAY_MS, Math.floor(jittered));
}

/** Build the absolute WS URL. The path returned by `wsUrl()` is
 *  already browser-relative (e.g. `/signoz/ws/logs/v5/{orgId}`); we
 *  anchor it against `location.origin` so `new WebSocket()` always
 *  sees a fully-qualified URL regardless of the dev proxy or
 *  reverse-proxy in front of it. */
function buildFullUrl(path: string): string {
  // Defensive guard for SSR / test environments where `location` is
  // undefined; callers should not invoke this path in that case but
  // the fallback keeps the function total.
  const origin =
    typeof location !== 'undefined' && location?.origin
      ? location.origin
      : 'http://localhost';
  return new URL(path, origin).href;
}

/** Discover the SigNoz orgId via /api/v1/user. Returns 'default' on
 *  any failure (network, non-2xx, missing orgId field) so the WS
 *  upgrade can still attempt -- SigNoz itself decides whether the
 *  bogus orgId is fatal. */
async function discoverOrgId(): Promise<string> {
  const res = await currentUser();
  const orgId = res?.data?.orgId ?? res?.orgId;
  if (typeof orgId === 'string' && orgId.length > 0) return orgId;
  return DEFAULT_ORG_ID;
}

/** Send the initial tail filter over the open WS. The SigNoz v5
 *  live-tail protocol expects a JSON envelope with the filter
 *  payload; we send it as the first message after `open`. */
function sendFilter(wsHandle: WebSocket, filter: LiveTailFilter): void {
  try {
    wsHandle.send(JSON.stringify({
      filter: filter.query ?? DEFAULT_FILTER,
      severities: filter.severities ?? [],
      services: filter.services ?? [],
    }));
  } catch {
    // send() throws if the socket is mid-close; we silently let the
    // close handler take over rather than propagate.
  }
}

/** Parse one raw row from the WS payload into the LogRow contract.
 *  Returns `null` for inputs that don't satisfy the contract -- the
 *  caller is expected to drop the row (logged for diagnosability). */
function parseRawRow(raw: unknown): LogRow | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;

  // Timestamp: accept ms (`timestamp`), ms (`time`), or ns (`timestamp_nano`).
  let ts: number;
  if (typeof r.timestamp === 'number') ts = r.timestamp;
  else if (typeof r.time === 'number') ts = r.time;
  else if (typeof r.timestamp_nano === 'number')
    ts = Math.floor(r.timestamp_nano / 1_000_000);
  else ts = Date.now();

  // Severity: accept either `severity_text` or `severity`, normalize to
  // uppercase, and validate against the LogRow literal union.
  const sevRaw =
    typeof r.severity_text === 'string'
      ? r.severity_text
      : typeof r.severity === 'string'
        ? r.severity
        : 'INFO';
  const sev = sevRaw.toString().toUpperCase();
  if (
    sev !== 'DEBUG' &&
    sev !== 'INFO' &&
    sev !== 'WARN' &&
    sev !== 'ERROR' &&
    sev !== 'FATAL'
  ) {
    return null;
  }

  const service =
    typeof r.service_name === 'string'
      ? r.service_name
      : typeof r['service.name'] === 'string'
        ? (r['service.name'] as string)
        : typeof r.service === 'string'
          ? r.service
          : 'unknown';

  const body = typeof r.body === 'string' ? r.body : '';

  const traceId =
    typeof r.trace_id === 'string'
      ? r.trace_id
      : typeof r.traceId === 'string'
        ? r.traceId
        : undefined;

  const attributes =
    r.attributes && typeof r.attributes === 'object' && !Array.isArray(r.attributes)
      ? (r.attributes as Record<string, unknown>)
      : {};

  return {
    timestamp: ts,
    severity: sev,
    service,
    body,
    traceId,
    attributes,
    rawJson: r,
  };
}

/** Append a single parsed row to the logs.results array. Caps at
 *  10_000 rows so an unbounded tail doesn't OOM the browser. Older
 *  rows are dropped from the front of the array. */
const LIVE_TAIL_CAP = 10_000;

function appendLiveRow(row: LogRow): void {
  logs.update((s) => {
    const next = s.results.length >= LIVE_TAIL_CAP
      ? [...s.results.slice(s.results.length - LIVE_TAIL_CAP + 1), row]
      : [...s.results, row];
    return { ...s, results: next, totalRows: next.length };
  });
}

/** Parse a single WS message. Payload may be a JSON object (single row)
 *  or a JSON array (batch). Unknown shapes are logged and dropped. */
function handleMessage(raw: string): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Non-JSON frames are expected (some servers emit heartbeats as
    // plain text); drop silently.
    return;
  }
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  for (const r of rows) {
    const row = parseRawRow(r);
    if (row) appendLiveRow(row);
  }
}

// --- Connection lifecycle --------------------------------------------------

async function openConnection(filter: LiveTailFilter): Promise<void> {
  liveTailStatus.set('connecting');
  wsReady.set(toWsReady('connecting'));
  wsLastAttemptAt.set(Date.now());

  if (!cachedOrgId) {
    try {
      cachedOrgId = await discoverOrgId();
    } catch {
      cachedOrgId = DEFAULT_ORG_ID;
      toastWarn(
        'Could not discover SigNoz orgId; falling back to "default" (live tail may fail)',
      );
    }
  }

  const path = wsUrl(cachedOrgId);
  const fullUrl = buildFullUrl(path);

  // The browser throws synchronously if the URL is malformed, which is
  // a permanent failure -- treat it like the 10-attempt cap and bail.
  let handle: WebSocket;
  try {
    handle = new WebSocket(fullUrl);
  } catch (e) {
    handlePermanentFailure(
      e instanceof Error ? e.message : 'WebSocket construction failed',
    );
    return;
  }
  ws = handle;

  handle.onopen = (): void => {
    attempt = 0;
    liveTailAttempt.set(0);
    liveTailError.set(null);
    liveTailStatus.set('open');
    wsReady.set(toWsReady('open'));
    sendFilter(handle, filter);
  };

  handle.onmessage = (ev: MessageEvent): void => {
    if (typeof ev.data !== 'string') return;
    handleMessage(ev.data);
  };

  handle.onerror = (): void => {
    // Don't transition to `closed` here -- the close handler will fire
    // immediately after with a more specific reason. We just record the
    // error for the surface so it can be surfaced if we never recover.
    liveTailError.set('WebSocket error');
  };

  handle.onclose = (): void => {
    ws = null;
    if (get(liveTailStatus) === 'idle') return; // user toggled off

    // Count THIS close as the next failure, then check whether we've
    // hit the cap. `attempt` is the 1-based count of consecutive
    // reconnect attempts (0 at boot / after a successful open). The
    // 10th close therefore drives `attempt` to 10, which trips the
    // permanent-failure branch -- matching the spec: "10 consecutive
    // failures -> status 'closed', no further retries".
    attempt += 1;
    liveTailAttempt.set(attempt);
    wsLastAttemptAt.set(Date.now());

    if (attempt >= MAX_ATTEMPTS) {
      handlePermanentFailure(
        `Live tail unavailable after ${MAX_ATTEMPTS} attempts`,
      );
      return;
    }

    liveTailStatus.set('reconnecting');
    wsReady.set(toWsReady('reconnecting'));

    const delay = delayForAttempt(attempt);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void openConnection(filter);
    }, delay);
  };
}

/** Flip into the permanent-error state: cancel any pending timer,
 *  close the WS (no-op if already closed), and lock the status. */
function handlePermanentFailure(message: string): void {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (ws) {
    try {
      ws.close();
    } catch {
      /* swallow */
    }
    ws = null;
  }
  attempt = MAX_ATTEMPTS;
  liveTailAttempt.set(attempt);
  liveTailStatus.set('closed');
  wsReady.set(toWsReady('closed'));
  liveTailError.set(message);
}

// --- Public API ------------------------------------------------------------

/** Start the live-tail WS. Idempotent: a second call while already
 *  `connecting`, `open`, or `reconnecting` is a no-op. Calling from
 *  `'closed'` resets the attempt counter and retries. Calling from
 *  `'idle'` (the initial state) is the normal path. */
export function startLiveTail(filter: LiveTailFilter = {}): void {
  const s = get(liveTailStatus);
  if (s === 'connecting' || s === 'open' || s === 'reconnecting') return;

  // Reset the failure bookkeeping so a manual start after `closed`
  // gets a fresh 10-attempt budget.
  attempt = 0;
  liveTailAttempt.set(0);
  liveTailError.set(null);
  logsLive.set(true);
  void openConnection(filter);
}

/** Stop the live-tail WS. Closes the socket, clears any pending
 *  reconnect timer, and resets all status to the initial `'idle'`
 *  state. Safe to call when already idle. */
export function stopLiveTail(): void {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (ws) {
    try {
      ws.close();
    } catch {
      /* swallow */
    }
    ws = null;
  }
  attempt = 0;
  liveTailStatus.set('idle');
  liveTailAttempt.set(0);
  liveTailError.set(null);
  wsReady.set(toWsReady('idle'));
  logsLive.set(false);
}

/** Predicate: true if the WS is connecting, open, or reconnecting.
 *  Used by callers that want to avoid double-starts or display a
 *  "live" indicator without subscribing to the writable. */
export function isLiveTailActive(): boolean {
  const s = get(liveTailStatus);
  return s === 'connecting' || s === 'open' || s === 'reconnecting';
}

/** Test-only escape hatch. Mirrors the `__resetForTesting` pattern
 *  used by `logsStore` and `savedViews`: cancels any pending timer,
 *  closes any active WS, and resets all writables to their initial
 *  state. Tests call this in `beforeEach` so the module-scoped
 *  state doesn't leak between cases (browser-mode vitest caches
 *  the module instance across the suite). */
export function __resetForTesting(): void {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (ws) {
    try {
      ws.close();
    } catch {
      /* swallow */
    }
    ws = null;
  }
  cachedOrgId = null;
  attempt = 0;
  liveTailStatus.set('idle');
  liveTailAttempt.set(0);
  liveTailError.set(null);
  wsReady.set('closed');
  logsLive.set(false);
}