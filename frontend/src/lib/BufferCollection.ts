import type { Buffer } from '../types';
import { normalizeChannelName, naturalCompare } from './utils';

/**
 * Lightweight indexed collection for Buffer objects.
 *
 * Eliminates O(n) array.find() lookups and provides IRCCloud-style
 * sorted channel lists with the server buffer always first.
 */
export class BufferCollection {
  private _byName = new Map<string, Buffer>();
  private _items: Buffer[] = [];

  /** All buffers in sorted order (server first, then alphabetically). */
  get items(): ReadonlyArray<Buffer> { return this._items; }

  /** Number of buffers in the collection. */
  get length(): number { return this._items.length; }

  /** O(1) indexed lookup. */
  get(name: string): Buffer | undefined {
    return this._byName.get(normalizeChannelName(name));
  }

  /** Returns true if a buffer with the given name exists. */
  has(name: string): boolean {
    return this._byName.has(normalizeChannelName(name));
  }

  /**
   * Add a buffer at the correct sorted position.
   * Returns the inserted buffer (the same reference).
   */
  add(buf: Buffer): Buffer {
    buf.name = normalizeChannelName(buf.name);
    if (this._byName.has(buf.name)) {
      // Buffer already exists — merge update
      const existing = this._byName.get(buf.name)!;
      Object.assign(existing, buf);
      return existing;
    }
    this._byName.set(buf.name, buf);
    this._insertSorted(buf);
    return buf;
  }

  /** Remove a buffer by name. Returns the removed buffer or undefined. */
  remove(name: string): Buffer | undefined {
    const norm = normalizeChannelName(name);
    const buf = this._byName.get(norm);
    if (!buf) return undefined;
    this._byName.delete(norm);
    this._items = this._items.filter(b => b.name !== norm);
    return buf;
  }

  /** Clear all buffers. */
  clear(): void {
    this._byName.clear();
    this._items = [];
  }

  /** Replace entire collection from a sync payload. */
  sync(buffers: Buffer[]): void {
    // Remove buffers not in the sync
    const syncNames = new Set(buffers.map(b => normalizeChannelName(b.name)));
    for (const [name] of this._byName) {
      if (!syncNames.has(name)) this.remove(name);
    }
    // Add/update sync buffers
    for (const b of buffers) this.add({ ...b });
  }

  /** Filter buffers by a predicate. */
  filter(predicate: (b: Buffer) => boolean): Buffer[] {
    return this._items.filter(predicate);
  }

  /** Find a buffer by predicate (O(n) — use get() for name lookups). */
  find(predicate: (b: Buffer) => boolean): Buffer | undefined {
    return this._items.find(predicate);
  }

  /** Iterate over buffers. */
  forEach(fn: (b: Buffer) => void): void {
    this._items.forEach(fn);
  }

  /** Map buffers. */
  map<T>(fn: (b: Buffer) => T): T[] {
    return this._items.map(fn);
  }

  /** Reduce over buffers. */
  reduce<T>(fn: (acc: T, b: Buffer) => T, initial: T): T {
    return this._items.reduce(fn, initial);
  }

  /** Check if any buffer matches a predicate. */
  some(predicate: (b: Buffer) => boolean): boolean {
    return this._items.some(predicate);
  }

  // ── Private helpers ──

  private _insertSorted(buf: Buffer): void {
    // Server buffer always first
    if (buf.name === '_server') {
      this._items.unshift(buf);
      return;
    }
    // Insert in natural sort order (case-insensitive, like IRCCloud)
    for (let i = 0; i < this._items.length; i++) {
      if (this._items[i].name === '_server') continue;
      if (naturalCompare(buf.name, this._items[i].name) < 0) {
        this._items.splice(i, 0, buf);
        return;
      }
    }
    this._items.push(buf);
  }
}
