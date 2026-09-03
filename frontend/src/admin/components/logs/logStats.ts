/**
 * logStats -- pure aggregation helpers for the /logs chart strip.
 *
 * All panels on the Logs page derive from the already-loaded rows
 * (no extra SigNoz queries): the volume area buckets them by time,
 * the severity pie counts them, and the services list ranks them.
 * Pure functions so they stay in the lib-style node test project.
 */

export type LogSeverity = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR' | 'FATAL';

export const SEVERITY_ORDER: readonly LogSeverity[] = [
  'DEBUG',
  'INFO',
  'WARN',
  'ERROR',
  'FATAL',
];

/** Minimal row shape the aggregations need (LogRow satisfies it). */
export interface StatRow {
  timestamp: number;
  severity: string;
  service: string;
}

export interface TimeBucket {
  /** Bucket start (ms since epoch). */
  t: number;
  DEBUG: number;
  INFO: number;
  WARN: number;
  ERROR: number;
  FATAL: number;
  total: number;
}

function isSeverity(s: string): s is LogSeverity {
  return (SEVERITY_ORDER as readonly string[]).includes(s);
}

/** Bucket rows into `bucketCount` equal slices of [start, end].
 *  Rows outside the window are clamped into the edge buckets so live
 *  rows that arrive a tick past `end` still show up. */
export function bucketizeByTime(
  rows: readonly StatRow[],
  start: number,
  end: number,
  bucketCount = 48,
): TimeBucket[] {
  const n = Math.max(1, Math.floor(bucketCount));
  const span = end - start;
  const buckets: TimeBucket[] = Array.from({ length: n }, (_, i) => ({
    t: span > 0 ? start + Math.floor((span * i) / n) : start,
    DEBUG: 0,
    INFO: 0,
    WARN: 0,
    ERROR: 0,
    FATAL: 0,
    total: 0,
  }));
  if (span <= 0) {
    for (const r of rows) addRow(buckets[0]!, r);
    return buckets;
  }
  for (const r of rows) {
    const idx = Math.min(n - 1, Math.max(0, Math.floor(((r.timestamp - start) / span) * n)));
    addRow(buckets[idx]!, r);
  }
  return buckets;
}

function addRow(b: TimeBucket, r: StatRow): void {
  b.total += 1;
  if (isSeverity(r.severity)) b[r.severity] += 1;
}

/** Per-severity totals in SEVERITY_ORDER, dropping zero counts (a pie
 *  slice of size zero renders nothing but still eats legend space). */
export function severityCounts(
  rows: readonly StatRow[],
): { severity: LogSeverity; count: number }[] {
  const counts = new Map<LogSeverity, number>();
  for (const r of rows) {
    if (!isSeverity(r.severity)) continue;
    counts.set(r.severity, (counts.get(r.severity) ?? 0) + 1);
  }
  return SEVERITY_ORDER.filter((s) => (counts.get(s) ?? 0) > 0).map((s) => ({
    severity: s,
    count: counts.get(s) ?? 0,
  }));
}

/** Top-N services by row count (descending). Ties break
 *  alphabetically so the ranking is stable across renders. */
export function topServices(
  rows: readonly StatRow[],
  n = 8,
): { service: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const r of rows) {
    if (!r.service) continue;
    counts.set(r.service, (counts.get(r.service) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([service, count]) => ({ service, count }))
    .sort((a, b) => b.count - a.count || a.service.localeCompare(b.service))
    .slice(0, Math.max(0, n));
}
