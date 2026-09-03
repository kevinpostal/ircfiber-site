/**
 * logStats -- aggregation helpers for the /logs chart strip.
 * Pure functions over plain row fixtures (no stores, no DOM).
 */
import { describe, expect, it } from 'vitest';
import {
  bucketizeByTime,
  severityCounts,
  topServices,
  type StatRow,
} from './logStats';

function row(ts: number, severity = 'INFO', service = 'svc'): StatRow {
  return { timestamp: ts, severity, service };
}

describe('bucketizeByTime', () => {
  it('splits rows into equal buckets with per-severity counts', () => {
    const rows = [row(0, 'INFO'), row(25, 'ERROR'), row(50, 'INFO'), row(99, 'WARN')];
    const out = bucketizeByTime(rows, 0, 100, 2);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ t: 0, INFO: 1, ERROR: 1, total: 2 });
    expect(out[1]).toMatchObject({ t: 50, INFO: 1, WARN: 1, total: 2 });
  });

  it('clamps out-of-window rows into the edge buckets', () => {
    const out = bucketizeByTime([row(-50, 'INFO'), row(500, 'ERROR')], 0, 100, 2);
    expect(out[0]!.total).toBe(1);
    expect(out[1]!.total).toBe(1);
  });

  it('ignores unknown severity strings for the split but still counts the row', () => {
    const out = bucketizeByTime([row(10, 'NOPE')], 0, 100, 1);
    expect(out[0]).toMatchObject({ total: 1, INFO: 0, ERROR: 0 });
  });

  it('handles empty rows and degenerate windows', () => {
    expect(bucketizeByTime([], 0, 100, 4)).toHaveLength(4);
    const out = bucketizeByTime([row(5, 'INFO')], 100, 100, 4);
    expect(out[0]!.total).toBe(1);
  });
});

describe('severityCounts', () => {
  it('returns SEVERITY_ORDER entries with nonzero counts only', () => {
    const out = severityCounts([
      row(1, 'ERROR'),
      row(2, 'ERROR'),
      row(3, 'WARN'),
      row(4, 'NOPE'),
    ]);
    expect(out).toEqual([
      { severity: 'WARN', count: 1 },
      { severity: 'ERROR', count: 2 },
    ]);
  });

  it('returns [] for no rows', () => {
    expect(severityCounts([])).toEqual([]);
  });
});

describe('topServices', () => {
  it('ranks by count desc, ties alpha, caps at n', () => {
    const rows = [
      row(1, 'INFO', 'b'),
      row(2, 'INFO', 'a'),
      row(3, 'INFO', 'b'),
      row(4, 'INFO', 'c'),
      row(5, 'INFO', ''),
    ];
    expect(topServices(rows, 2)).toEqual([
      { service: 'b', count: 2 },
      { service: 'a', count: 1 },
    ]);
    // '' service is skipped; c ties with a but loses alphabetically.
    expect(topServices(rows, 10).map((s) => s.service)).toEqual(['b', 'a', 'c']);
  });
});
