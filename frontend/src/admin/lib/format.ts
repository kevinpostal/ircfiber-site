/**
 * Format helpers for the admin SPA.
 *
 * - `bytes(n)`     — formats a byte count as a human-readable string (KB/MB/GB)
 * - `duration(ms)` — formats a millisecond duration as "1h 23m" / "45s" / etc.
 * - `relative(ms)` — formats a unix-ms timestamp as a relative-time string ("3m ago")
 * - `percent(n,d)` — formats a ratio as a percentage with one decimal
 * - `shortNumber(n)` — formats large numbers with k/m/b suffix
 */

export function bytes(n: number | null | undefined): string {
  if (n == null || !isFinite(n)) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function duration(ms: number | null | undefined): string {
  if (ms == null) return '—';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

export function relative(ms: number | null | undefined, now: number = Date.now()): string {
  if (ms == null || ms <= 0) return '—';
  const diff = now - ms;
  if (diff < 1000) return 'just now';
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

export function percent(num: number | null | undefined, denom: number | null | undefined): string {
  if (num == null || denom == null || denom === 0) return '—';
  const p = (num / denom) * 100;
  return `${p.toFixed(1)}%`;
}

export function shortNumber(n: number | null | undefined): string {
  if (n == null) return '—';
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  if (n < 1_000_000_000) return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 1 : 0)}m`;
  return `${(n / 1_000_000_000).toFixed(1)}b`;
}

export function hostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

export function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}