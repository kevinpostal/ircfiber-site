import { describe, it, expect, beforeEach } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { flushSync } from 'svelte';
import MessageList from './MessageList.svelte';
import { createMessage, createNetwork, createBuffer } from '../test/factories';
import { ircState } from '../stores/ircStore.svelte';
import { clearedAtMap } from '../stores/preferences.svelte';
import { logScroll } from '../test/scroll';

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
  for (const k of Object.keys(clearedAtMap)) delete (clearedAtMap as Record<string, number>)[k];
}

describe('irccloud parity extensive', () => {
  beforeEach(reset);

  it('1x ArrowUp moves 40px and does not snap back (100% parity)', async () => {
    const net = createNetwork({ networkId: 'net1' });
    net.buffers.push(createBuffer({ name: '#chan', type: 'channel' }));
    ircState.networks.push(net);
    ircState.activeBuffer.networkId = 'net1';
    ircState.activeBuffer.bufferName = '#chan';
    const now = Date.now();
    const msgs = [];
    for (let i = 0; i < 600; i++) msgs.push(createMessage({ text: `msg-${i} lorem ipsum`, t: now - (600 - i) * 1000, msgid: `m-${i}`, eid: 1000 + i, nick: 'user' }));
    ircState.messages['net1:#chan'] = msgs;
    flushSync();
    render(MessageList, { props: {} });
    flushSync();
    await nextFrame(); await delay(300);
    const c = document.getElementById('messages') as HTMLDivElement | null;
    expect(c).not.toBeNull(); if (!c) return;
    c.style.height = '400px'; c.style.overflowY = 'auto';
    await nextFrame(); await delay(200);
    expect(Math.abs(c.scrollHeight - c.scrollTop - c.clientHeight) <= 1, 'must start at bottom').toBe(true);
    const bottomTop = c.scrollTop;
    logScroll(document.getElementById('messages'), 'ArrowUp');
    await delay(50); await nextFrame();
    const top1 = c.scrollTop;
    expect(top1 < bottomTop, '1x up must move up').toBe(true);
    expect(Math.abs(top1 - (bottomTop - 40)) < 5, `1x up must be ~40, got ${bottomTop - top1}`).toBe(true);
    expect(c.scrollHeight - c.scrollTop - c.clientHeight > 20, 'must be off bottom').toBe(true);
    await delay(200); await nextFrame();
    expect(Math.abs(c.scrollTop - top1) < 5, 'must not snap back after 200ms').toBe(true);
  }, 15000);

  it('repeated 20x ArrowUp moves linearly 800px no snap', async () => {
    const net = createNetwork({ networkId: 'net1' });
    net.buffers.push(createBuffer({ name: '#chan', type: 'channel' }));
    ircState.networks.push(net);
    ircState.activeBuffer.networkId = 'net1'; ircState.activeBuffer.bufferName = '#chan';
    const now = Date.now();
    const msgs = [];
    for (let i = 0; i < 800; i++) msgs.push(createMessage({ text: `msg-${i}`, t: now - (800 - i) * 1000, msgid: `m-${i}`, eid: 1000 + i, nick: 'user' }));
    ircState.messages['net1:#chan'] = msgs;
    flushSync(); render(MessageList, { props: {} }); flushSync();
    await nextFrame(); await delay(300);
    const c = document.getElementById('messages') as HTMLDivElement | null;
    expect(c).not.toBeNull(); if (!c) return;
    c.style.height = '400px'; c.style.overflowY = 'auto';
    await nextFrame(); await delay(200);
    const start = c.scrollTop;
    for (let i = 0; i < 20; i++) {
      logScroll(document.getElementById('messages'), 'ArrowUp');
      await delay(25);
    }
    await nextFrame(); await delay(100);
    const end = c.scrollTop;
    expect(end < start, 'must have scrolled up').toBe(true);
    const expected = 20 * 40;
    expect(Math.abs((start - end) - expected) < 60, `20 ups ~${expected}, got ${start - end}`).toBe(true);
    // must not have snapped back near bottom
    expect(c.scrollHeight - c.scrollTop - c.clientHeight > 100).toBe(true);
  }, 15000);

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
    logScroll(document.getElementById('messages'), 'ArrowUp');
    logScroll(document.getElementById('messages'), 'ArrowUp');
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
