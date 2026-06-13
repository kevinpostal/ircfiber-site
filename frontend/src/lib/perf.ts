// Lightweight performance timing helpers for the frontend.
// The harness is opt-in: nothing runs unless setPerfEnabled(true) is called,
// so the production bundle has zero overhead.

let enabled = false;

export function setPerfEnabled(v: boolean): void {
  enabled = v;
}

export function isPerfEnabled(): boolean {
  return enabled;
}

export function perfMark(label: string): number | null {
  if (!enabled) return null;
  const t = performance.now();
  // eslint-disable-next-line no-console
  console.log(`[perf] ${label}: ${t.toFixed(2)}`);
  return t;
}

export function perfMeasure(label: string, start: number | null): number | null {
  if (!enabled || start == null) return null;
  const d = performance.now() - start;
  // eslint-disable-next-line no-console
  console.log(`[perf] ${label}: ${d.toFixed(2)}ms`);
  return d;
}
