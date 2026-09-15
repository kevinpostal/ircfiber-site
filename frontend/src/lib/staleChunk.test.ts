import { describe, expect, it, beforeEach, vi } from 'vitest';
import { isStaleChunkError, recoverFromStaleChunk } from './staleChunk';

// The `lib` test project runs in node, which has no sessionStorage and no
// slot for one on globalThis. Naming the widened global once keeps the
// stub installs below from asserting a shape inline.
const testGlobal = globalThis as typeof globalThis & { sessionStorage: Storage };

/** An in-memory Storage, so the reload guard has somewhere to remember. */
function memoryStorage(): Storage {
  const store = new Map<string, string>();
  return {
    get length() { return store.size; },
    clear: () => store.clear(),
    getItem: (key) => store.get(key) ?? null,
    key: (index) => [...store.keys()][index] ?? null,
    removeItem: (key) => void store.delete(key),
    setItem: (key, value) => void store.set(key, value),
  };
}

beforeEach(() => {
  testGlobal.sessionStorage = memoryStorage();
});

describe('isStaleChunkError', () => {
  it('recognises the messages browsers use for a missing chunk', () => {
    for (const message of [
      'Failed to fetch dynamically imported module: https://ircfiber.com/public/dist/assets/chunk-lazy-DBJhY4Bx.js',
      'error loading dynamically imported module',
      'Importing a module script failed.',
      'Loading chunk 42 failed',
    ]) {
      expect(isStaleChunkError(new Error(message))).toBe(true);
    }
  });

  it('leaves unrelated failures alone', () => {
    // A reload costs the user their compose buffer and scroll position, so
    // anything that is not a missing chunk must never trigger one.
    expect(isStaleChunkError(new Error('NetworkError when attempting to fetch resource'))).toBe(false);
    expect(isStaleChunkError(new TypeError('x is not a function'))).toBe(false);
    expect(isStaleChunkError(undefined)).toBe(false);
    expect(isStaleChunkError('nope')).toBe(false);
  });
});

describe('recoverFromStaleChunk', () => {
  const stale = (): Error =>
    new Error('Failed to fetch dynamically imported module: /assets/chunk-lazy-x.js');

  it('reloads once and then refuses, so a broken deploy cannot loop', () => {
    const reload = vi.fn();

    expect(recoverFromStaleChunk(stale(), reload)).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);

    // The reload landed on a server that still lacks the chunk: the caller
    // gets false and renders a recovery surface instead of reloading again.
    expect(recoverFromStaleChunk(stale(), reload)).toBe(false);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('does not reload for an error that is not a missing chunk', () => {
    const reload = vi.fn();
    expect(recoverFromStaleChunk(new Error('boom'), reload)).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });

  it('still reloads when storage is unavailable', () => {
    // Private-mode Safari throws on sessionStorage access. The repair has to
    // happen anyway; it just cannot remember that it already tried.
    const blocked: Storage = {
      ...memoryStorage(),
      getItem: () => { throw new Error('blocked'); },
      setItem: () => { throw new Error('blocked'); },
    };
    testGlobal.sessionStorage = blocked;

    const reload = vi.fn();
    expect(recoverFromStaleChunk(stale(), reload)).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
