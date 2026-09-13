/**
 * Polling helper — calls a fetcher at a fixed interval, honoring the global
 * pollingEnabled toggle. Pages call `startPolling(...)` in onMount and the
 * returned function in onDestroy.
 *
 * `pollingEnabled` is the topbar "Pause auto-refresh" switch and it is
 * persisted in localStorage, so it pauses the *refresh* only: the first load
 * always runs. Gating the initial fetch on it meant one stray click left
 * every page permanently empty across reloads (prod: a tab with
 * `ircfiber-admin:polling=false` rendered the whole dashboard — KPIs, Mongo,
 * Redis, engines — as em dashes because no fetcher had ever run).
 */
import { pollingEnabled } from './ui';
import { get } from 'svelte/store';

export interface PollingOptions {
  intervalMs?: number;
}

export function startPolling(fetcher: () => void | Promise<void>, opts: PollingOptions = {}): () => void {
  const interval = opts.intervalMs ?? 5_000;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight = false;
  let loadedOnce = false;

  const clearTimer = () => {
    if (timer) { clearTimeout(timer); timer = null; }
  };

  const tick = async () => {
    if (stopped) return;
    if (!inFlight) {
      inFlight = true;
      loadedOnce = true;
      try { await fetcher(); } catch { /* swallow; pages handle their own errors */ }
      finally { inFlight = false; }
    }
    // Reschedule only while auto-refresh is on: a paused page keeps the data
    // it loaded and stops burning requests.
    if (stopped || !get(pollingEnabled)) return;
    clearTimer();
    timer = setTimeout(tick, interval);
  };

  // Runs on subscribe (current value) and on every toggle flip. Resuming
  // refetches at once; pausing drops the timer without clearing any state.
  const apply = (enabled: boolean) => {
    clearTimer();
    if (stopped) return;
    if (enabled || !loadedOnce) void tick();
  };

  const unsubscribe = pollingEnabled.subscribe(apply);

  return () => {
    stopped = true;
    clearTimer();
    unsubscribe();
  };
}
