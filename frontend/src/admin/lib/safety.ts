/**
 * Client-side mirror of the Mongo filter safety rules enforced by the backend.
 * Used to provide immediate feedback as the admin types a filter, before the
 * round-trip to the server. The server is still the source of truth.
 */

const BLOCKED = new Set([
  '$where', '$function', '$accumulator', '$expr',
  '$out', '$merge', '$lookup', '$graphLookup',
]);

/** Returns true if the filter contains no operator the server will reject. */
export function filterLooksSafe(filter: unknown): { ok: boolean; reason?: string } {
  return walk(filter, '$');
}

function walk(value: unknown, parentKey: string): { ok: boolean; reason?: string } {
  if (value == null || typeof value !== 'object') return { ok: true };
  if (Array.isArray(value)) {
    for (const item of value) {
      const r = walk(item, parentKey);
      if (!r.ok) return r;
    }
    return { ok: true };
  }
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (k.startsWith('$')) {
      if (BLOCKED.has(k)) return { ok: false, reason: `${k} is not allowed` };
    }
    const r = walk(v, k);
    if (!r.ok) return r;
  }
  return { ok: true };
}

/** Returns a short hint about the server's hard limits, for UI display. */
export const MONGO_LIMITS = {
  maxLimit: 100,
  maxTimeMs: 10_000,
  defaultLimit: 20,
  defaultMaxTimeMs: 2_000,
} as const;