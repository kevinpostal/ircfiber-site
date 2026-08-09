import type { IRCMessage } from '../types';

/**
 * Message batcher — "as fast as possible" flush strategy.
 *
 * Pure pub/sub (no backend queueing) means 1000 events arrive as 1000
 * individual WS frames in the browser, all within microseconds of each
 * other. To make the chat feel like a single block of HTML appearing
 * instantly (not a 200ms trickle), we:
 *
 *   1. NO grace period — first message schedules a 0ms setTimeout, which
 *      fires on the very next macrotask (~4ms, the browser's minimum).
 *   2. NO timer extension — each new message does NOT push the deadline
 *      forward. The 0ms timer is fixed at "fire on the next macrotask
 *      after the first message". This way a 100-message burst that
 *      trickles in over 100ms still flushes as ONE batch ~4ms after M1.
 *   3. HARD CAP at MAX_BUFFER_SIZE — if the queue ever hits N messages,
 *      flush immediately, no waiting. This caps the worst case for a
 *      paste of 1000+ lines: 5 instant flushes of 200 each, all inside
 *      the same microtask.
 *
 * Stage transitions:
 *
 *   (no timer)        --M1--> schedule 0ms, mode=burst
 *   [burst]           --M2..MN (any number)--> timer NOT extended
 *   [burst]           --next macrotask--> flush all queued
 *   [burst]           --queue >= MAX_BUFFER--> flush immediately
 *   [burst]           --flush--> clear queue, mode=null
 *
 * Trade-off: this prioritises low latency over aggressive batching. For
 * IRCCloud-style behaviour where M1 alone is rendered instantly and the
 * rest wait, switch the timer to 200ms with extension — but the user
 * reported that this is exactly what they don't want.
 */

type FlushFn = (networkId: string, bufferName: string, msgs: IRCMessage[]) => void;
let flushFn: FlushFn | null = null;
let backfillFlushFn: FlushFn | null = null;

// Per-buffer queue: key = `${networkId}:${bufferName}`
const queue = new Map<string, IRCMessage[]>();
const backfillQueue = new Map<string, IRCMessage[]>();

// Tracked separately from queue iteration so the cap check is O(1).
let totalQueued = 0;
let totalBackfillQueued = 0;

const MAX_BUFFER_SIZE = 200;        // force-flush threshold

export function setFlushFn(fn: FlushFn): void {
  flushFn = fn;
}

export function setBackfillFlushFn(fn: FlushFn): void {
  backfillFlushFn = fn;
}

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
    if (totalBackfillQueued >= MAX_BUFFER_SIZE) {
      flushAll();
      return;
    }
    if (flushTimeout === null) {
      flushTimeout = setTimeout(flushAll, 0);
    }
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

  // Hard cap: if the queue is large, flush immediately. O(1) check.
  if (totalQueued >= MAX_BUFFER_SIZE) {
    flushAll();
    return;
  }

  // First message in a batch schedules a 0ms timer. Subsequent messages
  // do NOT extend it — the timer fires on the next macrotask (~4ms)
  // regardless of how many more messages arrive. This is the fastest
  // possible flush while still coalescing messages that arrive in the
  // same tick.
  if (flushTimeout === null) {
    flushTimeout = setTimeout(flushAll, 0);
  }
}

let flushTimeout: ReturnType<typeof setTimeout> | null = null;

function flushAll(): void {
  if (flushTimeout !== null) {
    clearTimeout(flushTimeout);
    flushTimeout = null;
  }

  // Flush live queue
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

  // Flush backfill queue via separate flush fn (prepend path, no unread)
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

  // If flushFn was not set, we still cleared the queues to avoid leak.
  if (!flushFn && !backfillFlushFn) {
    // already cleared above, nothing more
  }
}
