/**
 * logsStore -- query state + debounced fetch for the admin Logs panel.
 *
 * Pattern mirrors dashboard.ts: named writables (logs, logsLoading,
 * logsError, logsLive) so consumers subscribe to each independently as
 * `$logs`, `$logsLoading`, `$logsError`, `$logsLive`. The store is
 * testable in jsdom / chromium without mounting a Svelte component --
 * only `svelte/store` is imported. The fetch surface goes through the
 * shared `../../lib/signoz` wrapper (consumed as `queryRange`).
 *
 * Persistence: the canonical filter (query, services, severities,
 * timeRange) is written to localStorage under
 *   `ircfiber:admin:logs:lastQuery`
 * on every state change. Volatile fields (results, lastQueryBody,
 * expandedRowIds, totalRows) are excluded -- they belong to a transient
 * fetch result, not the saved query. The schema deliberately matches
 * `savedViews.ts`'s LogsViewSnapshot minus volatile fields so the
 * future SigNoz SavedView backend swap stays decoupled.
 *
 * Debounce: setQuery / setService / setSeverity / setTimeRange schedule
 * a 200ms trailing debounce that fires runQuery() exactly once after
 * the burst settles. runQuery() is the immediate path -- it cancels
 * any pending debounce and any in-flight request, then fires the new
 * fetch. cancelQuery() is the inverse: it aborts the in-flight request
 * and clears the pending debounce, leaving the logs in a clean state.
 */
import { get, writable, type Writable } from 'svelte/store';
import { ApiError, queryRange, type QueryRangeRequest } from '../../lib/signoz';

const PERSIST_KEY = 'ircfiber:admin:logs:lastQuery';
const DEBOUNCE_MS = 200;

// --- Public types ---------------------------------------------------------

export interface LogRow {
  timestamp: number;
  severity: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR' | 'FATAL';
  service: string;
  body: string;
  traceId?: string;
  attributes: Record<string, unknown>;
  rawJson: unknown;
}

export interface TimeRange {
  label: '5m' | '15m' | '1h' | '3h' | '24h' | 'custom';
  start: number;
  end: number;
}

export interface LogsState {
  query: string;
  services: string[];
  severities: string[];
  timeRange: TimeRange;
  results: LogRow[];
  lastQueryBody: unknown;
  expandedRowIds: Set<string>;
  totalRows: number;
}

/** Curated default severity filter -- actionable subset, not all five. */
export const DEFAULT_SEVERITIES = ['WARN', 'ERROR'] as const;
export const DEFAULT_TIME_RANGE_LABEL: TimeRange['label'] = '5m';

const VALID_TIME_RANGE_LABELS: ReadonlySet<TimeRange['label']> = new Set([
  '5m',
  '15m',
  '1h',
  '3h',
  '24h',
  'custom',
]);

const VALID_SEVERITIES: ReadonlySet<LogRow['severity']> = new Set([
  'DEBUG',
  'INFO',
  'WARN',
  'ERROR',
  'FATAL',
]);

// --- Internal helpers ----------------------------------------------------

function nowRange(label: TimeRange['label']): TimeRange {
  const end = Date.now();
  let spanMs: number;
  switch (label) {
    case '5m':
      spanMs = 5 * 60_000;
      break;
    case '15m':
      spanMs = 15 * 60_000;
      break;
    case '1h':
      spanMs = 60 * 60_000;
      break;
    case '3h':
      spanMs = 3 * 60 * 60_000;
      break;
    case '24h':
      spanMs = 24 * 60 * 60_000;
      break;
    default:
      spanMs = 5 * 60_000;
  }
  return { label, start: end - spanMs, end };
}

function defaultState(): LogsState {
  return {
    query: '',
    services: [],
    severities: [...DEFAULT_SEVERITIES],
    timeRange: nowRange(DEFAULT_TIME_RANGE_LABEL),
    results: [],
    lastQueryBody: null,
    expandedRowIds: new Set(),
    totalRows: 0,
  };
}

/**
 * Shape of the persisted payload -- only the fields the plan enumerates.
 * Volatile state (results / lastQueryBody / expandedRowIds / totalRows)
 * deliberately excluded so a saved query restores cleanly across reloads.
 */
interface PersistedLastQuery {
  query: string;
  services: string[];
  severities: string[];
  timeRange: TimeRange;
}

function loadPersisted(): Partial<LogsState> | null {
  if (typeof localStorage === 'undefined') return null;
  let raw: string | null;
  try {
    raw = localStorage.getItem(PERSIST_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<PersistedLastQuery>;
    const out: Partial<LogsState> = {};
    if (typeof parsed.query === 'string') out.query = parsed.query;
    if (Array.isArray(parsed.services)) {
      out.services = parsed.services.filter(
        (s): s is string => typeof s === 'string',
      );
    }
    if (Array.isArray(parsed.severities)) {
      out.severities = parsed.severities.filter(
        (s): s is string => typeof s === 'string' && VALID_SEVERITIES.has(s as LogRow['severity']),
      );
    }
    if (
      parsed.timeRange &&
      typeof parsed.timeRange === 'object' &&
      typeof parsed.timeRange.start === 'number' &&
      typeof parsed.timeRange.end === 'number' &&
      VALID_TIME_RANGE_LABELS.has(parsed.timeRange.label as TimeRange['label'])
    ) {
      out.timeRange = {
        label: parsed.timeRange.label as TimeRange['label'],
        start: parsed.timeRange.start,
        end: parsed.timeRange.end,
      };
    }
    return out;
  } catch {
    return null;
  }
}

function persist(state: LogsState): void {
  if (typeof localStorage === 'undefined') return;
  try {
    const payload: PersistedLastQuery = {
      query: state.query,
      services: [...state.services],
      severities: [...state.severities],
      timeRange: { ...state.timeRange },
    };
    localStorage.setItem(PERSIST_KEY, JSON.stringify(payload));
  } catch {
    /* quota exceeded / serialization failure -- non-fatal */
  }
}

function initialState(): LogsState {
  const base = defaultState();
  const loaded = loadPersisted();
  if (!loaded) return base;
  return {
    ...base,
    ...loaded,
    // These four fields are NEVER restored from persistence even if the
    // payload somehow carried them through (defense-in-depth).
    results: base.results,
    lastQueryBody: base.lastQueryBody,
    expandedRowIds: base.expandedRowIds,
    totalRows: base.totalRows,
  };
}

// --- Store exports --------------------------------------------------------

export const logs: Writable<LogsState> = writable<LogsState>(initialState());
export const logsLoading: Writable<boolean> = writable<boolean>(false);
export const logsError: Writable<string | null> = writable<string | null>(null);
export const logsLive: Writable<boolean> = writable<boolean>(false);

/**
 * Live-tail WebSocket state. Driven by w3-t1 (the WS reconnect task);
 * the toolbar in w2-t2 just reads these for the status badge.
 *   - 'open'         : WS connected, streaming.
 *   - 'reconnecting' : WS dropped, backoff in flight.
 *   - 'closed'       : WS closed (initial state before any attempt).
 */
export type WsReadyState = 'open' | 'reconnecting' | 'closed';
export const wsReady: Writable<WsReadyState> = writable<WsReadyState>('closed');

/**
 * Unix-ms timestamp of the last (re)connect attempt. Surfaced by the
 * toolbar to show "Disconnected - last attempt <relative time>" when
 * `wsReady === 'closed'` and `logsLive === true`. Zero means no attempt
 * has been made yet (initial state).
 */
export const wsLastAttemptAt: Writable<number> = writable<number>(0);

// Auto-persist the canonical filter fields on every state change.
// Guarded so node-side consumers (e.g. SSR, lib-project tests that
// stub localStorage) don't blow up.
if (typeof window !== 'undefined' && typeof localStorage !== 'undefined') {
  logs.subscribe((state) => persist(state));
}

// --- Internal mutable state (module-scoped, not exported) ----------------

let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let inFlight: AbortController | null = null;

// --- Query body construction ----------------------------------------------

function escapeFilterString(s: string): string {
  // SigNoz filter grammar uses single-quoted strings; escape embedded
  // backslashes first, then single quotes. The body is a CONTAINS match
  // so this only needs to survive the grammar, not SQL-injection-proof.
  return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function buildRequest(state: LogsState): QueryRangeRequest {
  const clauses: string[] = [];
  if (state.severities.length > 0) {
    const list = state.severities.map((s) => `'${s}'`).join(',');
    clauses.push(`severity_text IN (${list})`);
  }
  if (state.services.length > 0) {
    const list = state.services.map((s) => `'${escapeFilterString(s)}'`).join(',');
    clauses.push(`service.name IN (${list})`);
  }
  const trimmed = state.query.trim();
  if (trimmed.length > 0) {
    clauses.push(`body CONTAINS '${escapeFilterString(trimmed)}'`);
  }
  const expression = clauses.length === 0 ? '' : clauses.join(' AND ');
  return {
    start: state.timeRange.start,
    end: state.timeRange.end,
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
            filter: { expression },
          },
        },
      ],
    },
  };
}

function parseRow(item: unknown): LogRow {
  const r = (item ?? {}) as Record<string, unknown>;
  const ts = typeof r.timestamp === 'number' ? r.timestamp : Date.now();
  const sevRaw =
    typeof r.severity_text === 'string'
      ? r.severity_text
      : typeof r.severity === 'string'
        ? r.severity
        : 'INFO';
  const sev: LogRow['severity'] = VALID_SEVERITIES.has(sevRaw as LogRow['severity'])
    ? (sevRaw as LogRow['severity'])
    : 'INFO';
  const service =
    typeof r.service_name === 'string'
      ? r.service_name
      : typeof r.service === 'string'
        ? r.service
        : '';
  const body = typeof r.body === 'string' ? r.body : '';
  const traceId =
    typeof r.trace_id === 'string'
      ? r.trace_id
      : typeof r.traceId === 'string'
        ? r.traceId
        : undefined;
  const attributes =
    r.attributes && typeof r.attributes === 'object'
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

// --- Mutators ------------------------------------------------------------

export function setQuery(q: string): void {
  logs.update((s) => ({ ...s, query: q }));
  scheduleRefetch();
}

export function setService(svc: string | null): void {
  logs.update((s) => {
    if (svc === null || svc === '') return { ...s, services: [] };
    const next = new Set(s.services);
    if (next.has(svc)) next.delete(svc);
    else next.add(svc);
    return { ...s, services: Array.from(next) };
  });
  scheduleRefetch();
}

export function setSeverity(sev: string | null): void {
  logs.update((s) => {
    if (sev === null || sev === '') return { ...s, severities: [...DEFAULT_SEVERITIES] };
    const next = new Set(s.severities);
    if (next.has(sev)) next.delete(sev);
    else next.add(sev);
    return { ...s, severities: Array.from(next) };
  });
  scheduleRefetch();
}

export function setTimeRange(range: TimeRange): void {
  logs.update((s) => ({ ...s, timeRange: range }));
  scheduleRefetch();
}

export function toggleLive(): void {
  logsLive.update((v) => !v);
}

export function toggleExpandedRow(id: string): void {
  logs.update((s) => {
    const next = new Set(s.expandedRowIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return { ...s, expandedRowIds: next };
  });
}

function scheduleRefetch(): void {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    void runQuery();
  }, DEBOUNCE_MS);
}

export function resetFilters(): void {
  cancelQuery();
  const base = defaultState();
  logs.set(base);
  // Persist the default immediately so the next reload sees clean state
  // even if no follow-up query is run. The subscribe on `logs` would
  // also write this, but doing it explicitly keeps the contract obvious
  // and survives a future unsubscribe.
  persist(base);
}

// --- Query execution -----------------------------------------------------

export async function runQuery(): Promise<void> {
  // Cancel any pending debounced refetch -- the manual call supersedes it.
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  // Cancel any in-flight request -- this call replaces it.
  if (inFlight) {
    inFlight.abort();
    inFlight = null;
  }

  const state = get(logs);
  const body = buildRequest(state);
  logs.update((s) => ({ ...s, lastQueryBody: body }));
  logsError.set(null);
  logsLoading.set(true);

  const ac = new AbortController();
  inFlight = ac;
  try {
    const res = await queryRange(body, { signal: ac.signal });
    if (ac.signal.aborted) return;
    const data = (res?.data ?? {}) as Record<string, { list?: readonly unknown[] }>;
    const a = data['A'];
    const list = Array.isArray(a?.list) ? a!.list! : [];
    const rows = list.map(parseRow);
    const totalRaw = (a as { total?: unknown } | undefined)?.total;
    const total = typeof totalRaw === 'number' ? totalRaw : rows.length;
    logs.update((s) => ({ ...s, results: rows, totalRows: total }));
  } catch (e) {
    // User-driven aborts are silent -- cancelQuery handles the loading
    // state and the consumer doesn't want a toast for a deliberate
    // cancel. Network/HTTP failures from signoz.ts surface as ApiError.
    if (ac.signal.aborted) return;
    const msg = e instanceof ApiError ? e.message : (e as Error)?.message ?? 'Unknown error';
    logsError.set(msg);
  } finally {
    if (inFlight === ac) inFlight = null;
    logsLoading.set(false);
  }
}

export function cancelQuery(): void {
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  if (inFlight) {
    inFlight.abort();
    inFlight = null;
  }
  logsLoading.set(false);
}

/**
 * @internal -- test-only escape hatch. Re-runs the module's initial
 * initializer against the current localStorage contents, so a test can
 * seed the persistence key and observe the restored state without
 * relying on `vi.resetModules() + await import(...)`, which in vitest's
 * browser mode returns the same cached module instance as the static
 * top-of-file import. Mirrors `savedViews.ts`'s `__resetForTesting`
 * pattern.
 */
export function __resetForTesting(): void {
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  if (inFlight) {
    inFlight.abort();
    inFlight = null;
  }
  logs.set(initialState());
  logsLoading.set(false);
  logsError.set(null);
  logsLive.set(false);
  wsReady.set('closed');
  wsLastAttemptAt.set(0);
}