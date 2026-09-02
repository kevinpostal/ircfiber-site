import type { IRCMessage } from '../types';

/**
 * Message batcher — mixed strategy.
 *
 * Live chat: IRCCloud `checkFlush` cadence — flush at once when idle,
 * otherwise every 200 ms while a burst is in flight, so a 100-message
 * burst renders as a few blocks instead of a hundred reactive ticks.
 *
 * Backfill/history: debounced 200ms with extension — REST 150 + CHATHISTORY
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
const BACKFILL_DEBOUNCE_MS = 200;

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
  checkFlush();
}

// IRCCloud BufferLogView.checkFlush: flush immediately when the last flush
// was more than bufferFlushTimeout (200 ms) ago, otherwise re-check in
// 200 ms so a burst renders in ≤5 batches/s instead of one per message.
const FLUSH_INTERVAL_MS = 200;
let lastFlush = 0;
function checkFlush(): void {
  if (!lastFlush || Date.now() - lastFlush >= FLUSH_INTERVAL_MS) {
    flushAll();
  } else if (flushTimeout === null) {
    flushTimeout = setTimeout(checkFlush, FLUSH_INTERVAL_MS);
  }
}

function compareBatch(a: IRCMessage, b: IRCMessage): number {
  const ta = (a.t ?? 0) as number;
  const tb = (b.t ?? 0) as number;
  if (ta !== tb) return ta - tb;
  const ea = a.eid;
  const eb = b.eid;
  if (ea != null && eb != null) return ea - eb;
  if (ea != null) return -1;
  if (eb != null) return 1;
  return (a.msgid ?? '').localeCompare(b.msgid ?? '');
}

function flushAll(): void {
  lastFlush = Date.now();
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
        if (msgs.length > 1) msgs.sort(compareBatch);
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
        if (msgs.length > 1) msgs.sort(compareBatch);
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
