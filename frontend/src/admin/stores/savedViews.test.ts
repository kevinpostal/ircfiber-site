/**
 * savedViews — localStorage-backed SavedView persistence.
 *
 * `vi.resetModules()` does not reliably invalidate the browser's ESM
 * cache in vitest's playwright provider, so the in-memory writable
 * would otherwise leak between cases. We use the module's own
 * `__resetForTesting` hook to clear both the store and the
 * localStorage key in `beforeEach`, and statically import the module
 * so the same instance is reused across the suite (its `toasts`
 * counter in ui.ts is therefore cumulative, which is fine — we only
 * inspect the array contents).
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { get } from 'svelte/store';
import * as mod from './savedViews';
import { toasts } from './ui';

const STORAGE_KEY = 'ircfiber:admin:logs:views';

beforeEach(() => {
  mod.__resetForTesting();
  toasts.set([]);
});

function makeQuery(
  overrides: Partial<{
    query: string;
    services: string[];
    severities: string[];
    label: string;
    start: number;
    end: number;
  }> = {},
) {
  return {
    query: overrides.query ?? 'severity=ERROR',
    services: overrides.services ?? ['irc-fiber-engine'],
    severities: overrides.severities ?? ['ERROR'],
    timeRange: {
      label: overrides.label ?? 'Last 1h',
      start: overrides.start ?? 1_000,
      end: overrides.end ?? 2_000,
    },
  };
}

describe('saveView round-trip', () => {
  it('returns a SavedView with the expected fields and adds it to views', () => {
    const q = makeQuery();
    const v = mod.saveView('errors-only', q, q.timeRange);
    expect(v.id).toBeTruthy();
    expect(typeof v.id).toBe('string');
    expect(v.name).toBe('errors-only');
    expect(v.query).toEqual(q);
    expect(v.timeRange).toEqual(q.timeRange);
    expect(typeof v.createdAt).toBe('number');
    expect(typeof v.updatedAt).toBe('number');
    expect(v.createdAt).toBe(v.updatedAt);
    expect(get(mod.views).length).toBe(1);
    expect(get(mod.views)[0].id).toBe(v.id);
  });

  it('persists to localStorage under ircfiber:admin:logs:views', () => {
    const q = makeQuery();
    mod.saveView('persisted', q, q.timeRange);
    const raw = window.localStorage.getItem(STORAGE_KEY);
    expect(raw).toBeTruthy();
    const parsed = JSON.parse(raw as string);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].name).toBe('persisted');
    expect(parsed[0].query.query).toBe('severity=ERROR');
    expect(parsed[0].timeRange.label).toBe('Last 1h');
  });

  it('stores a defensive copy of the snapshot (caller mutation does not leak in)', () => {
    const q = makeQuery();
    const tr = q.timeRange;
    const v = mod.saveView('independent', q, tr);
    // Mutate the caller's references after saving. Stored view must not change.
    q.query = 'MUTATED';
    q.services.push('rogue-svc');
    q.severities.push('FATAL');
    tr.label = 'MUTATED-RANGE';
    expect(v.query.query).toBe('severity=ERROR');
    expect(v.query.services).toEqual(['irc-fiber-engine']);
    expect(v.query.severities).toEqual(['ERROR']);
    expect(v.timeRange.label).toBe('Last 1h');
  });
});

describe('idempotent by name', () => {
  beforeEach(() => {
    // Pin time so the two saves have a strictly-increasing updatedAt;
    // under real timers, two consecutive saves can land in the same
    // millisecond and make the strict-greater assertion flaky.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-01-01T00:00:00.000Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('a second save with the same name updates in place (same id, bumped updatedAt)', () => {
    const q1 = makeQuery({ query: 'first' });
    const q2 = makeQuery({ query: 'second' });
    const a = mod.saveView('same-name', q1, q1.timeRange);
    vi.advanceTimersByTime(5);
    const b = mod.saveView('same-name', q2, q2.timeRange);
    expect(b.id).toBe(a.id);
    expect(b.createdAt).toBe(a.createdAt);
    expect(b.updatedAt).toBeGreaterThan(a.updatedAt);
    expect(b.query.query).toBe('second');
    expect(get(mod.views).length).toBe(1);
  });
});

describe('loadView', () => {
  it('returns the saved view by id', () => {
    const q = makeQuery();
    const v = mod.saveView('lookup-me', q, q.timeRange);
    const loaded = mod.loadView(v.id);
    expect(loaded.id).toBe(v.id);
    expect(loaded.name).toBe('lookup-me');
    expect(loaded.query).toEqual(q);
    expect(loaded.timeRange).toEqual(q.timeRange);
  });

  it('throws when the id does not exist', () => {
    expect(() => mod.loadView('not-a-real-id')).toThrow();
  });
});

describe('listViews', () => {
  it('returns a snapshot of all saved views', () => {
    const q = makeQuery();
    mod.saveView('a', q, q.timeRange);
    mod.saveView('b', q, q.timeRange);
    const list = mod.listViews();
    expect(list).toHaveLength(2);
    expect(list.map((v) => v.name).sort()).toEqual(['a', 'b']);
  });

  it('returns an empty array when nothing is saved', () => {
    expect(mod.listViews()).toEqual([]);
  });
});

describe('deleteView', () => {
  it('removes the view from the store and localStorage', () => {
    const q = makeQuery();
    const v = mod.saveView('to-delete', q, q.timeRange);
    mod.deleteView(v.id);
    expect(get(mod.views).length).toBe(0);
    const raw = window.localStorage.getItem(STORAGE_KEY);
    expect(raw).toBeTruthy();
    expect(JSON.parse(raw as string)).toEqual([]);
  });

  it('is a no-op for unknown ids (does not throw)', () => {
    const q = makeQuery();
    mod.saveView('keep', q, q.timeRange);
    expect(() => mod.deleteView('not-real')).not.toThrow();
    expect(get(mod.views).length).toBe(1);
  });
});

describe('LRU prune at 50 entries', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-01-01T00:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('after 51 saves, the oldest is dropped and toastWarn is called', () => {
    const q = makeQuery();
    // Re-pin the clock here in case the outer beforeEach ran under real
    // timers between cases (the static import means the module's
    // _views was created at first import; resetting it to [] via
    // __resetForTesting does not touch the clock).
    vi.setSystemTime(new Date('2024-01-01T00:00:00.000Z'));

    const first = mod.saveView('v0', { ...q, query: 'q0' }, q.timeRange);
    vi.advanceTimersByTime(1);
    for (let i = 1; i < 50; i++) {
      mod.saveView('v' + i, { ...q, query: 'q' + i }, q.timeRange);
      vi.advanceTimersByTime(1);
    }
    expect(get(mod.views).length).toBe(50);
    expect(get(toasts).filter((t) => t.kind === 'warn').length).toBe(0);

    mod.saveView('v50', { ...q, query: 'q50' }, q.timeRange);

    const final = get(mod.views);
    expect(final.length).toBe(50);
    // The very first save (v0) has the smallest updatedAt and must be
    // the one dropped; v50 (most recent) must still be present.
    expect(final.find((v) => v.id === first.id)).toBeUndefined();
    expect(final.find((v) => v.name === 'v50')).toBeDefined();
    const warns = get(toasts).filter((t) => t.kind === 'warn');
    expect(warns.length).toBeGreaterThan(0);
    expect(warns[0].message).toBe('Saved views trimmed to 50 most-recent.');
  });
});

describe('quota exceeded', () => {
  it('saveView does not throw; toastError is called; in-memory store keeps the view', () => {
    // Simulate the browser rejecting setItem (Safari private mode, full
    // quota, etc.). Only the savedViews key trips; everything else is a
    // no-op so the spy is invisible to unrelated code paths.
    const stub = vi
      .spyOn(window.localStorage, 'setItem')
      .mockImplementation((key: string, _value: string) => {
        if (key === STORAGE_KEY) {
          throw new Error('QuotaExceededError');
        }
        // No-op for other keys (none expected during this test).
      });

    const q = makeQuery();
    let saved: ReturnType<typeof mod.saveView> | undefined;
    expect(() => {
      saved = mod.saveView('quota-test', q, q.timeRange);
    }).not.toThrow();
    expect(saved).toBeDefined();
    expect(get(mod.views).length).toBe(1);
    expect(get(mod.views)[0].name).toBe('quota-test');
    const errs = get(toasts).filter((t) => t.kind === 'error');
    expect(errs.length).toBeGreaterThan(0);
    expect(errs[0].message).toMatch(/quota/i);

    stub.mockRestore();
  });
});
