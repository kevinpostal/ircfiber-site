import { describe, expect, it, beforeEach } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { flushSync, tick } from 'svelte';
import MessageList from './MessageList.svelte';
import { createMessage, createNetwork, createBuffer } from '../test/factories';
import { ircState, batchAppendMessages } from '../stores/ircStore.svelte';
import { clearedAtMap, lastSeenMap, focusSeenMap, bottomSeenMap } from '../stores/preferences.svelte';

// iOS Safari delivers touch-drag / momentum `scroll` events sparsely. These
// tests model that: the finger moves the list (scrollTop write) and a burst
// is processed BEFORE the browser's own scroll event for that move fires
// (it lands on the next rendering step; everything up to the first
// `setTimeout` await is same-task microtasks). Dispatching a synthetic
// `scroll` right after the write would hide the bug.

function resetState(): void {
  ircState.networks.length = 0;
  ircState.activeBuffer.networkId = null;
  ircState.activeBuffer.bufferName = null;
  ircState.messages = {};
  ircState.processedMessages = {};
  ircState.optimisticMessages.clear();
  ircState.backlogDivider = {};
  ircState.lastSeenMsgTime = null;
  ircState.focusLost = false;
  ircState.forceScrollToBottomNonce = 0;
  Object.keys(clearedAtMap).forEach((k) => delete (clearedAtMap as Record<string, unknown>)[k]);
  Object.keys(lastSeenMap).forEach((k) => delete (lastSeenMap as Record<string, unknown>)[k]);
  Object.keys(focusSeenMap).forEach((k) => delete (focusSeenMap as Record<string, unknown>)[k]);
  Object.keys(bottomSeenMap).forEach((k) => delete (bottomSeenMap as Record<string, unknown>)[k]);
}

beforeEach(() => resetState());

// Real timers on purpose: the browser must run its own rendering step (to
// fire the native scroll event) and `performance.now()` drives the grace
// window inside MessageList — fake timers advance neither.
function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

function touch(el: HTMLElement, type: 'touchstart' | 'touchend' | 'touchcancel'): void {
  let ev: Event;
  try { ev = new TouchEvent(type, { bubbles: true }); } catch { ev = new Event(type, { bubbles: true }); }
  el.dispatchEvent(ev);
}

async function mountPinned(): Promise<{ scroller: HTMLElement; base: number }> {
  const net = createNetwork({ networkId: 'net1' });
  net.buffers.push(createBuffer({ name: '#chan' }));
  ircState.networks.push(net);
  ircState.activeBuffer.networkId = 'net1';
  ircState.activeBuffer.bufferName = '#chan';
  const base = Date.now();
  ircState.messages['net1:#chan'] = Array.from({ length: 250 }, (_, i) => createMessage({ text: `old ${i}`, t: base + i * 1000, eid: i + 1, msgid: `o${i}` }));
  flushSync();
  const { container } = render(MessageList, { props: {} });
  await tick();
  const scroller = container.querySelector('#messages') as HTMLElement;
  // The test viewport is unconstrained; give the list a phone-sized
  // height so it actually scrolls, and let the container ResizeObserver
  // re-pin (IRCCloud autogrow checkRecent) settle.
  scroller.style.height = '500px';
  scroller.style.overflowY = 'auto';
  expect(scroller.scrollHeight).toBeGreaterThan(scroller.clientHeight);
  await sleep(150);
  scroller.scrollTop = scroller.scrollHeight;
  scroller.dispatchEvent(new Event('scroll'));
  await tick();
  await sleep(150);
  expect(dist(scroller)).toBeLessThanOrEqual(2);
  return { scroller, base };
}

function dist(el: HTMLElement): number {
  return el.scrollHeight - el.clientHeight - el.scrollTop;
}

async function append(base: number, n: number, tag: string, eid0: number): Promise<void> {
  const more = Array.from({ length: n }, (_, i) => createMessage({ text: `${tag} ${i}`, t: base + 500000 + eid0 * 10 + i, eid: eid0 + i, msgid: `${tag}${i}` }));
  batchAppendMessages('net1', '#chan', more);
  flushSync();
  await tick();
}

describe('MessageList touch-scroll pin suppression', () => {
  it('a burst while the finger is down does not pin', async () => {
    const { scroller, base } = await mountPinned();
    touch(scroller, 'touchstart');
    scroller.scrollTop -= 150;
    const dragged = scroller.scrollTop;
    await append(base, 20, 'burst', 5000);
    await sleep(250);
    expect(Math.abs(scroller.scrollTop - dragged)).toBeLessThan(5);
    expect(dist(scroller)).toBeGreaterThan(100);
  });

  it('content growth during momentum does not pin, and the window stays frozen after the grace expires', async () => {
    const { scroller, base } = await mountPinned();
    touch(scroller, 'touchstart');
    touch(scroller, 'touchend');
    scroller.scrollTop -= 150;
    const dragged = scroller.scrollTop;
    await append(base, 5, 'mom', 6000);
    await sleep(100);
    expect(Math.abs(scroller.scrollTop - dragged)).toBeLessThan(5);
    // Grace (1200 ms) expired: the browser's scroll event for the drag has
    // been processed by now, so cachedAtBottom is false and appends buffer.
    await sleep(1300);
    await append(base, 5, 'late', 7000);
    await sleep(100);
    expect(Math.abs(scroller.scrollTop - dragged)).toBeLessThan(5);
    expect(dist(scroller)).toBeGreaterThan(100);
  });

  it('a touch that ends at the bottom keeps pinning', async () => {
    const { scroller, base } = await mountPinned();
    touch(scroller, 'touchstart');
    touch(scroller, 'touchend');
    await append(base, 10, 'tap', 8000);
    expect(dist(scroller)).toBeLessThanOrEqual(2);
    await sleep(100);
    expect(dist(scroller)).toBeLessThanOrEqual(2);
  });
});

describe('MessageList content-growth scroll event', () => {
  // WebKit lays out a decoded image before it dispatches `load`, so the
  // silent pin's own delayed scroll event arrives with the same scrollTop
  // and a taller scrollHeight. That is growth, not a user scrolling up.
  it('re-pins when a scroll event reports growth without a viewport move', async () => {
    const { scroller, base } = await mountPinned();
    await append(base, 1, 'img', 9000);
    await sleep(100);
    expect(dist(scroller)).toBeLessThanOrEqual(2);
    const rows = scroller.querySelectorAll('.row');
    const last = rows[rows.length - 1] as HTMLElement;
    last.style.height = `${last.offsetHeight + 214}px`;
    expect(dist(scroller)).toBeGreaterThan(200);
    scroller.dispatchEvent(new Event('scroll'));
    await tick();
    await sleep(100);
    expect(dist(scroller)).toBeLessThanOrEqual(2);
    // Still pinned: the next append lands at the bottom, not in a frozen window.
    await append(base, 3, 'after', 9100);
    await sleep(100);
    expect(dist(scroller)).toBeLessThanOrEqual(2);
    expect(scroller.querySelectorAll('.row').length).toBe(rows.length + 3);
  });
});
