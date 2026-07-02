/**
 * savedViews — localStorage-backed SavedView persistence for the
 * admin Logs panel.
 *
 * Stable contract: saveView, loadView, deleteView, listViews, views (Readable).
 * The shape is intentionally decoupled from logsStore.ts; future SigNoz
 * SavedView backend swap will keep the same API. This snapshot shape
 * intentionally matches `logsStore.ts`'s LogsState minus volatile fields;
 * future SavedView backend integration will keep this contract.
 */
import { get, writable, type Readable, type Writable } from 'svelte/store';
import { toastError, toastWarn } from './ui';

export interface LogsViewSnapshot {
  query: string;
  services: string[];
  severities: string[];
  timeRange: { label: string; start: number; end: number };
}

export interface SavedView {
  id: string;
  name: string;
  query: LogsViewSnapshot;
  timeRange: LogsViewSnapshot['timeRange'];
  createdAt: number;
  updatedAt: number;
}

const STORAGE_KEY = 'ircfiber:admin:logs:views';
const MAX_VIEWS = 50;

function genId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function deepClone<T>(value: T): T {
  if (typeof structuredClone === 'function') {
    return structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value)) as T;
}

function hydrate(): SavedView[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed as SavedView[];
  } catch {
    return [];
  }
}

const _views: Writable<SavedView[]> = writable(hydrate());

// Expose only Readable so consumers cannot mutate via the store API.
export const views: Readable<SavedView[]> = { subscribe: _views.subscribe };

function persist(arr: SavedView[]): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(arr));
  } catch {
    // Quota / privacy mode / etc. — keep the in-memory copy and warn the
    // operator; do not throw out of saveView.
    toastError('Failed to persist saved views: storage quota exceeded.');
  }
}

function pruneIfNeeded(arr: SavedView[]): SavedView[] {
  if (arr.length <= MAX_VIEWS) return arr;
  // LRU: keep the MAX_VIEWS most-recently-updated entries. We sort
  // by updatedAt desc and slice. SavedView objects are plain data, so
  // the sort comparator is deterministic.
  const sorted = [...arr].sort((a, b) => b.updatedAt - a.updatedAt);
  const kept = sorted.slice(0, MAX_VIEWS);
  toastWarn('Saved views trimmed to 50 most-recent.');
  return kept;
}

export function saveView(
  name: string,
  query: LogsViewSnapshot,
  timeRange: LogsViewSnapshot['timeRange'],
): SavedView {
  const now = Date.now();
  const clonedQuery = deepClone(query);
  const clonedTimeRange = deepClone(timeRange);
  let result!: SavedView;
  _views.update((arr) => {
    // Idempotent by name: an existing view with the same name is
    // updated in place (same id, bumped updatedAt) instead of creating
    // a duplicate. This matches the "save" affordance in most UI lists
    // (e.g. browser bookmark managers, IDE workspaces).
    const existing = arr.find((v) => v.name === name);
    if (existing) {
      const updated: SavedView = {
        ...existing,
        query: clonedQuery,
        timeRange: clonedTimeRange,
        updatedAt: now,
      };
      result = updated;
      const next = pruneIfNeeded(
        arr.map((v) => (v.id === existing.id ? updated : v)),
      );
      persist(next);
      return next;
    }
    const created: SavedView = {
      id: genId(),
      name,
      query: clonedQuery,
      timeRange: clonedTimeRange,
      createdAt: now,
      updatedAt: now,
    };
    result = created;
    const next = pruneIfNeeded([...arr, created]);
    persist(next);
    return next;
  });
  return result;
}

export function loadView(id: string): SavedView {
  const arr = get(_views);
  const found = arr.find((v) => v.id === id);
  if (!found) {
    throw new Error(`SavedView not found: ${id}`);
  }
  // Return a defensive copy so callers cannot mutate stored state.
  return deepClone(found);
}

export function deleteView(id: string): void {
  _views.update((arr) => {
    const next = arr.filter((v) => v.id !== id);
    persist(next);
    return next;
  });
}

export function listViews(): SavedView[] {
  return deepClone(get(_views));
}

/**
 * @internal — test-only reset hook. Clears the in-memory store and the
 * localStorage key. The module is normally a singleton; tests need a
 * way to start each case from a known-empty state.
 */
export function __resetForTesting(): void {
  _views.set([]);
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}
