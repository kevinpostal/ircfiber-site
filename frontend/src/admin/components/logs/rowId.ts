/**
 * rowId -- stable identity for a LogRow.
 *
 * Used by both LogRow (when emitting onToggle) and LogTable (when looking
 * up the expanded state). Centralizing the derivation keeps the two
 * callers from drifting out of sync -- a bug where LogRow and LogTable
 * compute different ids for the same row would manifest as the row's
 * visual selection state not matching the parent's "is this row expanded"
 * answer.
 *
 * Identity strategy:
 *   - If traceId is present, that wins. Trace IDs are globally unique
 *     for the lifetime of a distributed trace, so two rows with the same
 *     traceId are the same event (e.g. duplicated across retries).
 *   - Otherwise, fall back to a synthesized key of timestamp + service
 *     + first 40 chars of the body. The 40-char prefix is a balance:
 *     short enough to be cheap, long enough that two rows with the same
 *     timestamp from the same service still collide only when their
 *     bodies really start the same way (rare).
 *
 * For test rows where body is empty, the fallback still produces a
 * well-defined, non-empty id.
 */

import type { LogRow } from '../../stores/logsStore';

export function getRowId(row: LogRow): string {
  if (row.traceId) return row.traceId;
  const prefix = (row.body ?? '').slice(0, 40);
  return `${row.timestamp}:${row.service}:${prefix}`;
}