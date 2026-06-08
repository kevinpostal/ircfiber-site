/**
 * Message batcher — IRCCloud-style 200ms batch flush.
 *
 * Instead of triggering a Svelte reactive update on every single incoming
 * IRC message, we collect messages per buffer and flush them in batches
 * at most every 200ms (or on the next animation frame).  This prevents
 * redundant re-renders during high-volume bursts (MOTD, join floods,
 * backlog catch-up).
 *
 * Pattern mirrors IRCCloud's BufferLogView.messageBuffer.
 */

import { ircState } from '../stores/ircStore.svelte';

const FLUSH_INTERVAL_MS = 200;
type FlushFn = (networkId: string, bufferName: string, msgs: IRCMessage[]) => void;
let flushFn: FlushFn | null = null;
let flushTimer: ReturnType<typeof setTimeout> | null = null;

// Per-buffer queue: key = `${networkId}:${bufferName}`
const queue = new Map<string, IRCMessage[]>();

export function setFlushFn(fn: FlushFn): void {
  flushFn = fn;
}

export function enqueueMessage(networkId: string, bufferName: string, msg: IRCMessage): void {
  const key = `${networkId}:${bufferName}`;
  let list = queue.get(key);
  if (!list) {
    list = [];
    queue.set(key, list);
  }
  list.push(msg);

  if (!flushTimer) {
    flushTimer = setTimeout(flushAll, FLUSH_INTERVAL_MS);
  }
}

function flushAll(): void {
  flushTimer = null;
  if (!flushFn) {
    queue.clear();
    return;
  }
  for (const [key, msgs] of queue) {
    const [networkId, bufferName] = splitKey(key);
    if (msgs.length > 0) {
      flushFn(networkId, bufferName, msgs.splice(0));
    }
  }
  // Reschedule if new messages arrived during flush
  let hasPending = false;
  for (const [, msgs] of queue) {
    if (msgs.length > 0) { hasPending = true; break; }
  }
  if (hasPending && !flushTimer) {
    flushTimer = setTimeout(flushAll, FLUSH_INTERVAL_MS);
  }
}

function splitKey(key: string): [string, string] {
  const idx = key.indexOf(':');
  return [key.slice(0, idx), key.slice(idx + 1)];
}

import type { IRCMessage } from '../types';
