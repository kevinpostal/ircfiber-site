/**
 * Polling helper — calls a fetcher at a fixed interval, honoring the global
 * pollingEnabled toggle. Pages call `startPolling(...)` in onMount and the
 * returned function in onDestroy.
 */
import { pollingEnabled } from './ui';
import { get } from 'svelte/store';

export interface PollingOptions {
  intervalMs?: number;
  immediate?: boolean;
}

export function startPolling(fetcher: () => void | Promise<void>, opts: PollingOptions = {}): () => void {
  const interval = opts.intervalMs ?? 5_000;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight = false;

  const tick = async () => {
    if (stopped) return;
    if (!inFlight) {
      inFlight = true;
      try { await fetcher(); } catch { /* swallow; pages handle their own errors */ }
      finally { inFlight = false; }
    }
    if (stopped) return;
    timer = setTimeout(tick, interval);
  };

  // Honour pause toggle at the start
  let unsubscribe = () => {};
  const applyPolling = () => {
    if (timer) { clearTimeout(timer); timer = null; }
    if (get(pollingEnabled)) {
      if (opts.immediate !== false) tick();
      else timer = setTimeout(tick, interval);
    }
  };
  unsubscribe = pollingEnabled.subscribe(() => applyPolling());
  applyPolling();

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    unsubscribe();
  };
}