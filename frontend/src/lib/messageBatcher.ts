import type { IRCMessage } from '../types';

/**
 * Message batcher — mixed strategy.
 *
 * Live chat: "as fast as possible" — 0ms fixed deadline, no extension,
 * so a 100-message burst coalesces in ~4ms and renders as one block.
 *
 * Backfill/history: debounced 150ms with extension — REST 200 + CHATHISTORY
 * 100 that land 30ms apart coalesce into a single prependMessages() flush
 * instead of two renders ("IRC history then server messages" flicker at
 * /irc/Supernets/channel/superbowl). Cap raised to 400 so 300 fits.
 */

type FlushFn = (networkId: string, bufferName: string, msgs: IRCMessage[]) => void;
let flushFn: FlushFn | null = null;
let backfillFlushFn: FlushFn | null = null;
const queue = new Map<string, IRCMessage[]>();
const backfillQueue = new Map<string, IRCMessage[]>();

let totalQueued = 0;
let totalBackfillQueued = 0;

const MAX_BUFFER_SIZE = 200;
const MAX_BACKFILL_SIZE = 400;
const BACKFILL_DEBOUNCE_MS = 150;

export function setFlushFn(fn: FlushFn): void {
  flushFn = fn;
}

export function setBackfillFlushFn(fn: FlushFn): void {
  backfillFlushFn = fn;
}

let flushTimeout: ReturnType<typeof setTimeout> | null = null;
let backfillTimeout: ReturnType<typeof setTimeout> | null = null;

export function enqueueMessage(networkId: string, bufferName: string, msg: IRCMessage, isBackfill = false): void {
  if (isBackfill) {
    const key = `${networkId}:${bufferName}`;
    let list = backfillQueue.get(key);
    if (!list) {
      list = [];
      backfillQueue.set(key, list);
    }
    list.push(msg);
    totalBackfillQueued++;
    if (totalBackfillQueued >= MAX_BACKFILL_SIZE) {
      flushAll();
      return;
    }
    if (backfillTimeout !== null) clearTimeout(backfillTimeout);
    backfillTimeout = setTimeout(flushAll, BACKFILL_DEBOUNCE_MS);
    if (flushTimeout === null) flushTimeout = setTimeout(flushAll, 0);
    return;
  }
  const key = `${networkId}:${bufferName}`;
  let list = queue.get(key);
  if (!list) {
    list = [];
    queue.set(key, list);
  }
  list.push(msg);
  totalQueued++;
  if (totalQueued >= MAX_BUFFER_SIZE) {
    flushAll();
    return;
  }
  if (flushTimeout === null) {
    flushTimeout = setTimeout(flushAll, 0);
  }
}

function flushAll(): void {
  if (flushTimeout !== null) {
    clearTimeout(flushTimeout);
    flushTimeout = null;
  }
  if (backfillTimeout !== null) {
    clearTimeout(backfillTimeout);
    backfillTimeout = null;
  }

  if (flushFn && queue.size > 0) {
    const snapshot = new Map(queue);
    queue.clear();
    totalQueued = 0;
    for (const [key, msgs] of snapshot) {
      if (msgs.length > 0) {
        const idx = key.indexOf(':');
        const networkId = key.slice(0, idx);
        const bufferName = key.slice(idx + 1);
        flushFn(networkId, bufferName, msgs);
      }
    }
  } else if (queue.size > 0) {
    queue.clear();
    totalQueued = 0;
  }

  if (backfillFlushFn && backfillQueue.size > 0) {
    const snapshot = new Map(backfillQueue);
    backfillQueue.clear();
    totalBackfillQueued = 0;
    for (const [key, msgs] of snapshot) {
      if (msgs.length > 0) {
        const idx = key.indexOf(':');
        const networkId = key.slice(0, idx);
        const bufferName = key.slice(idx + 1);
        backfillFlushFn(networkId, bufferName, msgs);
      }
    }
  } else if (backfillQueue.size > 0) {
    backfillQueue.clear();
    totalBackfillQueued = 0;
  }
}
