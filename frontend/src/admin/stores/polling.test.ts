/**
 * startPolling — initial load vs. the topbar "Pause auto-refresh" toggle.
 *
 * `pollingEnabled` is persisted in localStorage (`ircfiber-admin:polling`), so
 * a paused toggle survives reloads. It must therefore stop the refresh loop
 * only: the first fetch always runs, otherwise every page renders em dashes
 * forever (the prod dashboard bug).
 */
import { describe, expect, it, afterEach, vi } from 'vitest';
import { startPolling } from './polling';
import { pollingEnabled } from './ui';

const STORAGE_KEY = 'ircfiber-admin:polling';
const INTERVAL = 5_000;

let stop: (() => void) | null = null;

afterEach(() => {
  stop?.();
  stop = null;
  vi.useRealTimers();
  pollingEnabled.set(true);
  localStorage.removeItem(STORAGE_KEY);
});

describe('startPolling', () => {
  it('loads once while auto-refresh is paused, then stays quiet', async () => {
    vi.useFakeTimers();
    pollingEnabled.set(false);
    let calls = 0;
    stop = startPolling(() => { calls++; }, { intervalMs: INTERVAL });

    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(INTERVAL * 5);
    expect(calls).toBe(1);
  });

  it('refetches and resumes the loop when auto-refresh is switched back on', async () => {
    vi.useFakeTimers();
    pollingEnabled.set(false);
    let calls = 0;
    stop = startPolling(() => { calls++; }, { intervalMs: INTERVAL });
    await vi.advanceTimersByTimeAsync(INTERVAL * 2);
    expect(calls).toBe(1);

    pollingEnabled.set(true);
    expect(calls).toBe(2);
    await vi.advanceTimersByTimeAsync(INTERVAL * 3);
    expect(calls).toBe(5);
  });

  it('stops refreshing when paused mid-flight and keeps whatever loaded', async () => {
    vi.useFakeTimers();
    let calls = 0;
    stop = startPolling(() => { calls++; }, { intervalMs: INTERVAL });
    await vi.advanceTimersByTimeAsync(INTERVAL * 3);
    expect(calls).toBe(4);

    pollingEnabled.set(false);
    await vi.advanceTimersByTimeAsync(INTERVAL * 5);
    expect(calls).toBe(4);
  });

  it('stops fetching after the returned disposer runs', async () => {
    vi.useFakeTimers();
    let calls = 0;
    const dispose = startPolling(() => { calls++; }, { intervalMs: INTERVAL });
    await vi.advanceTimersByTimeAsync(INTERVAL * 2);
    expect(calls).toBe(3);

    dispose();
    await vi.advanceTimersByTimeAsync(INTERVAL * 4);
    expect(calls).toBe(3);
  });
});
