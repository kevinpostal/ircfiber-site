/**
 * logsLiveTail -- polling live-tail of SigNoz logs via the gateway proxy.
 *
 * The old WebSocket path (`/signoz/ws/logs/v5/...` through Caddy) is
 * gone: the Caddy SigNoz block only renders with a key file the edge
 * host doesn't have, and proxying a SigNoz WS through the D gateway
 * would be a second protocol to maintain. Instead, while live is on we
 * re-run the current filter as a `queryRange` every POLL_MS through
 * `/api/admin/logs/query_range` and append rows we haven't seen.
 *
 * Status state machine (same stores/statuses the toolbar already reads):
 *
 *     idle ──startLiveTail──> connecting ──first success──> open
 *                                                  │
 *                                                  ├──poll error──> reconnecting ──next tick──> open
 *                                                  │                     │
 *                                                  │                     └──10 consecutive failures──> closed
 *                                                  │
 *                                                  └──stopLiveTail──> idle
 *
 * Failure cap: 10 consecutive poll failures after the LAST success
 * flips status to `closed` permanently (interval cleared).
 * `startLiveTail()` from `closed` resets the counter and retries.
 *
 * Row identity: `getRowId()` (traceId, else timestamp+service+body
 * prefix). Seen ids are capped so a days-long tail doesn't grow the
 * set without bound; rows are also skipped when older than the newest
 * row already appended, which covers the common re-poll overlap.
 */
import { get, writable, type Writable } from 'svelte/store';
import { queryRange, type QueryRangeRequest } from '../../lib/signoz';
import {
  logs,
  logsLive,
  wsLastAttemptAt,
  wsReady,
  type LogRow,
} from './logsStore';
import { getRowId } from '../components/logs/rowId';
import { toastWarn } from './ui';

// --- Constants -------------------------------------------------------------

/** Max consecutive poll failures before declaring permanent failure. */
const MAX_ATTEMPTS = 10;

/** Re-poll cadence while live. */
const POLL_MS = 5_000;

/** Active cadence; overridable by tests (the browser runner does not
 *  honor fake timers, so tests shrink the interval instead). */
let pollIntervalMs = POLL_MS;

/** Query window per poll (sliding "now forward" tail). */
const WINDOW_MS = 120_000;

/** Base backoff schedule in ms: 1s, 2s, 4s, 8s, 16s, 30s. Kept for the
 *  toolbar's "attempt n/10" display pacing and unit-tested below. */
const BASE_DELAYS_MS: readonly number[] = [
  1_000, 2_000, 4_000, 8_000, 16_000, 30_000,
];

/** Floor applied after the jitter math to keep delays >= 1s. */
const MIN_DELAY_MS = 1_000;

/** Cap for the seen-id set; cleared (not grown) past this. */
const SEEN_ID_CAP = 20_000;

/** Cap for appended live rows, mirroring the old WS tail. */
const LIVE_TAIL_CAP = 10_000;

// --- Public types ----------------------------------------------------------

export type LiveTailStatus =
  | 'idle'
  | 'connecting'
  | 'open'
  | 'reconnecting'
  | 'closed';

export interface LiveTailFilter {
  /** Body CONTAINS expression forwarded as a builder filter clause. */
  query?: string;
  /** Severity filter (e.g. `["ERROR","WARN"]`). */
  severities?: readonly string[];
  /** Service-name filter (e.g. `["irc-fiber-engine"]`). */
  services?: readonly string[];
  /**
   * Accepted for shape uniformity with `TimeRange`-aware query paths
   * but ignored: the poll tail is always "now forward" and cannot
   * rewind, so start/end/label are never serialized.
   */
  timeRange?: { start: number; end: number; label?: string };
}

// --- Writable stores -------------------------------------------------------

/** Live-tail connection state. */
export const liveTailStatus: Writable<LiveTailStatus> =
  writable<LiveTailStatus>('idle');

/** 1-based counter of consecutive poll failures (0 when fresh or after
 *  a success). Useful for UI badges ("attempt 3/10"). */
export const liveTailAttempt: Writable<number> = writable<number>(0);

/** Permanent error surfaced when MAX_ATTEMPTS is reached. `null` when
 *  the tail is healthy or still retrying. */
export const liveTailError: Writable<string | null> =
  writable<string | null>(null);

// --- Internal mutable state (module-scoped, not exported) -----------------

/** Active poll timer handle, or `null` when idle. */
let pollTimer: ReturnType<typeof setInterval> | null = null;

/** Current 1-based consecutive-failure counter (0 = fresh start). */
let attempt = 0;

/** Filter snapshot taken at startLiveTail time. */
let activeFilter: LiveTailFilter = {};

/** Row ids already appended (dedup across overlapping windows). */
let seenIds = new Set<string>();

/** Newest row timestamp appended; older rows are skipped outright. */
let maxSeenTs = 0;

/** In-flight guard so a slow poll never overlaps the next tick. */
let pollBusy = false;

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

function escapeFilterString(s: string): string {
  // Same grammar as logsStore: single-quoted SigNoz filter strings.
  return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/** Build the builder-query request for one poll tick: current filter
 *  over a sliding window ending now. */
function buildPollRequest(filter: LiveTailFilter, end: number): QueryRangeRequest {
  const clauses: string[] = [];
  const sevs = filter.severities ?? [];
  if (sevs.length > 0) {
    clauses.push(`severity_text IN (${sevs.map((s) => `'${s}'`).join(',')})`);
  }
  const svcs = filter.services ?? [];
  if (svcs.length > 0) {
    clauses.push(
      `service.name IN (${svcs.map((s) => `'${escapeFilterString(s)}'`).join(',')})`,
    );
  }
  const q = (filter.query ?? '').trim();
  if (q.length > 0) {
    clauses.push(`body CONTAINS '${escapeFilterString(q)}'`);
  }
  return {
    start: end - WINDOW_MS,
    end,
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
            filter: { expression: clauses.join(' AND ') },
          },
        },
      ],
    },
  };
}

/** Parse one raw row into the LogRow contract. Returns `null` for
 *  inputs that don't satisfy it -- the caller drops those silently. */
function parseRawRow(raw: unknown): LogRow | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;

  let ts: number;
  if (typeof r.timestamp === 'number') ts = r.timestamp;
  else if (typeof r.time === 'number') ts = r.time;
  else if (typeof r.timestamp_nano === 'number')
    ts = Math.floor(r.timestamp_nano / 1_000_000);
  else ts = Date.now();

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
    severity: sev as LogRow['severity'],
    service,
    body,
    traceId,
    attributes,
    rawJson: r,
  };
}

/** Append unseen rows to logs.results, capped at LIVE_TAIL_CAP. */
function appendNewRows(rows: LogRow[]): void {
  if (rows.length === 0) return;
  if (seenIds.size > SEEN_ID_CAP) {
    seenIds = new Set<string>();
  }
  logs.update((s) => {
    const fresh: LogRow[] = [];
    for (const row of rows) {
      if (row.timestamp < maxSeenTs) continue;
      const id = getRowId(row);
      if (seenIds.has(id)) continue;
      seenIds.add(id);
      if (row.timestamp > maxSeenTs) maxSeenTs = row.timestamp;
      fresh.push(row);
    }
    if (fresh.length === 0) return s;
    const next = [...s.results, ...fresh];
    const capped =
      next.length > LIVE_TAIL_CAP ? next.slice(next.length - LIVE_TAIL_CAP) : next;
    return { ...s, results: capped, totalRows: capped.length };
  });
}

// --- Poll lifecycle --------------------------------------------------------

async function pollOnce(): Promise<void> {
  if (pollBusy) return;
  if (get(liveTailStatus) === 'idle') return;
  pollBusy = true;
  try {
    const end = Date.now();
    const res = await queryRange(buildPollRequest(activeFilter, end));
    const data = (res?.data ?? {}) as Record<string, { list?: readonly unknown[] }>;
    const list = Array.isArray(data['A']?.list) ? data['A']!.list! : [];
    const rows: LogRow[] = [];
    for (const item of list) {
      const row = parseRawRow(item);
      if (row) rows.push(row);
    }
    // Oldest-first so maxSeenTs advances monotonically.
    rows.sort((a, b) => a.timestamp - b.timestamp);
    appendNewRows(rows);
    attempt = 0;
    liveTailAttempt.set(0);
    liveTailError.set(null);
    if (get(liveTailStatus) !== 'open') {
      liveTailStatus.set('open');
      wsReady.set(toWsReady('open'));
    }
  } catch (e) {
    attempt += 1;
    liveTailAttempt.set(attempt);
    wsLastAttemptAt.set(Date.now());
    if (attempt >= MAX_ATTEMPTS) {
      handlePermanentFailure(
        e instanceof Error ? e.message : 'Live tail unavailable',
      );
    } else {
      liveTailStatus.set('reconnecting');
      wsReady.set(toWsReady('reconnecting'));
    }
  } finally {
    pollBusy = false;
  }
}

/** Flip into the permanent-error state: stop the interval and lock. */
function handlePermanentFailure(message: string): void {
  stopTimer();
  attempt = MAX_ATTEMPTS;
  liveTailAttempt.set(attempt);
  liveTailStatus.set('closed');
  wsReady.set(toWsReady('closed'));
  liveTailError.set(`Live tail unavailable after ${MAX_ATTEMPTS} attempts: ${message}`);
  toastWarn('Live tail stopped after repeated failures - toggle Live off and on to retry');
}

function stopTimer(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

// --- Public API ------------------------------------------------------------

/** Start the polling live tail. Idempotent: a second call while
 *  already `connecting`, `open`, or `reconnecting` is a no-op.
 *  Calling from `'closed'` resets the attempt counter and retries. */
export function startLiveTail(filter: LiveTailFilter = {}): void {
  const s = get(liveTailStatus);
  if (s === 'connecting' || s === 'open' || s === 'reconnecting') return;

  // Fresh budget + fresh dedup window on every (re)start.
  attempt = 0;
  liveTailAttempt.set(0);
  liveTailError.set(null);
  seenIds = new Set<string>();
  maxSeenTs = 0;
  activeFilter = { ...filter };
  logsLive.set(true);
  liveTailStatus.set('connecting');
  wsReady.set(toWsReady('connecting'));
  wsLastAttemptAt.set(Date.now());
  void pollOnce();
  stopTimer();
  pollTimer = setInterval(() => {
    void pollOnce();
  }, pollIntervalMs);
}

/** Stop the polling live tail. Clears the interval and resets all
 *  status to the initial `'idle'` state. Safe to call when idle. */
export function stopLiveTail(): void {
  stopTimer();
  attempt = 0;
  pollBusy = false;
  liveTailStatus.set('idle');
  liveTailAttempt.set(0);
  liveTailError.set(null);
  wsReady.set(toWsReady('idle'));
  logsLive.set(false);
}

/** Predicate: true if the tail is connecting, open, or reconnecting.
 *  Used by callers that want to avoid double-starts or display a
 *  "live" indicator without subscribing to a writable. */
export function isLiveTailActive(): boolean {
  const s = get(liveTailStatus);
  return s === 'connecting' || s === 'open' || s === 'reconnecting';
}

/** Test-only escape hatch for the poll cadence. The browser test
 *  runner does not honor fake timers, so tests shrink the interval
 *  (e.g. 50ms) instead of advancing a fake clock. */
export function __setPollIntervalForTesting(ms: number): void {
  pollIntervalMs = ms;
}

/** Test-only escape hatch. Mirrors the `__resetForTesting` pattern
 *  used by `logsStore` and `savedViews`: clears the interval and
 *  resets all writables plus module-scoped dedup state to initial. */
export function __resetForTesting(): void {
  stopTimer();
  attempt = 0;
  pollBusy = false;
  activeFilter = {};
  seenIds = new Set<string>();
  maxSeenTs = 0;
  pollIntervalMs = POLL_MS;
  liveTailStatus.set('idle');
  liveTailAttempt.set(0);
  liveTailError.set(null);
  wsReady.set('closed');
  logsLive.set(false);
}
