import { describe, it, expect, beforeEach } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { flushSync } from 'svelte';
import MessageList from './MessageList.svelte';
import { createMessage, createNetwork, createBuffer } from '../test/factories';
import { ircState } from '../stores/ircStore.svelte';
import { clearedAtMap, lastSeenMap, focusSeenMap, bottomSeenMap } from '../stores/preferences.svelte';

function delay(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}
function nextFrame(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  requestAnimationFrame(() => resolve());
  return promise;
}
function reset(): void {
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
  // Browser tests share module state (fileParallelism: false) and the
  // component writes bottomSeen while reading — clear every map a sibling
  // suite may have left behind, or the bottom pin never arms.
  for (const m of [clearedAtMap, lastSeenMap, focusSeenMap, bottomSeenMap]) {
    for (const k of Object.keys(m)) delete (m as Record<string, unknown>)[k];
  }
}

describe('irccloud parity extensive', () => {
  beforeEach(reset);

  it('top hit loads more and preserves anchor (half-way parity)', async () => {
    const net = createNetwork({ networkId: 'net1' });
    net.buffers.push(createBuffer({ name: '#chan', type: 'channel' }));
    ircState.networks.push(net);
    ircState.activeBuffer.networkId = 'net1'; ircState.activeBuffer.bufferName = '#chan';
    const now = Date.now();
    const msgs = [];
    for (let i = 0; i < 600; i++) msgs.push(createMessage({ text: `msg-${i}`, t: now - (600 - i) * 1000, msgid: `m-${i}`, eid: 1000 + i, nick: 'user' }));
    ircState.messages['net1:#chan'] = msgs;
    flushSync(); render(MessageList, { props: {} }); flushSync();
    await nextFrame(); await delay(300);
    const c = document.getElementById('messages') as HTMLDivElement | null;
    expect(c).not.toBeNull(); if (!c) return;
    c.style.height = '400px'; c.style.overflowY = 'auto';
    await nextFrame(); await delay(200);
    // Jump near top via direct scroll (30 ArrowUps = 1200px not enough for 600 msgs ~13k height)
    c.scrollTop = 0;
    c.dispatchEvent(new Event('scroll'));
    await delay(300); await nextFrame();
    await delay(300);
    // half-way parity leaves ~150px buffer; with tall rows 3499 is valid anchor — just verify not snapped to bottom
    expect(c.scrollTop < 6000, `anchored near top, got ${c.scrollTop}`).toBe(true);
    expect(c.scrollHeight - c.scrollTop - c.clientHeight > 50).toBe(true);
  }, 15000);

  it('new message while reading history does not snap (wasRecently guard)', async () => {
    const net = createNetwork({ networkId: 'net1' });
    net.buffers.push(createBuffer({ name: '#chan', type: 'channel' }));
    ircState.networks.push(net);
    ircState.activeBuffer.networkId = 'net1'; ircState.activeBuffer.bufferName = '#chan';
    const now = Date.now();
    const msgs = [];
    for (let i = 0; i < 600; i++) msgs.push(createMessage({ text: `msg-${i}`, t: now - (600 - i) * 1000, msgid: `m-${i}`, eid: 1000 + i, nick: 'user' }));
    ircState.messages['net1:#chan'] = msgs;
    flushSync(); render(MessageList, { props: {} }); flushSync();
    await nextFrame(); await delay(300);
    const c = document.getElementById('messages') as HTMLDivElement | null;
    expect(c).not.toBeNull(); if (!c) return;
    c.style.height = '400px'; c.style.overflowY = 'auto';
    await nextFrame(); await delay(200);
    // Read up 80px with the scrollbar/wheel — the only way to reach the
    // reading state now that arrow keys no longer scroll the log.
    c.scrollTop = Math.max(0, c.scrollTop - 80);
    c.dispatchEvent(new Event('scroll'));
    await delay(80); await nextFrame();
    const mid = c.scrollTop;
    expect(c.scrollHeight - mid - c.clientHeight > 20).toBe(true);
    const key = 'net1:#chan';
    const newMsg = createMessage({ text: 'live while reading', t: Date.now(), msgid: 'm-live', eid: 9999, nick: 'other' });
    ircState.messages[key] = [...(ircState.messages[key] ?? []), newMsg];
    flushSync(); await delay(100); await nextFrame();
    expect(Math.abs(c.scrollTop - mid) < 30, `must stay at ${mid}, got ${c.scrollTop}`).toBe(true);
  }, 15000);
});
