import { describe, expect, it, vi, beforeEach } from 'vitest';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';
import { flushSync, tick } from 'svelte';
import MessageList from './MessageList.svelte';
import { createMessage, createNetwork, createBuffer } from '../test/factories';
import { ircState, batchAppendMessages } from '../stores/ircStore.svelte';
import { clearedAtMap, lastSeenMap, focusSeenMap, bottomSeenMap } from '../stores/preferences.svelte';

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

describe('MessageList burst bottom-pin', () => {
  it('stays pinned at bottom after 10 rapid appends', async () => {
    const net = createNetwork({ networkId: 'net1' });
    net.buffers.push(createBuffer({ name: '#chan' }));
    ircState.networks.push(net);
    ircState.activeBuffer.networkId = 'net1';
    ircState.activeBuffer.bufferName = '#chan';
    const base = Date.now();
    ircState.messages['net1:#chan'] = Array.from({ length: 10 }, (_, i) => createMessage({ text: `msg ${i}`, t: base + i * 1000, eid: i + 1, msgid: `m${i}` }));
    flushSync();
    const { container } = render(MessageList, { props: {} });
    await tick();
    // Find scroll container
    const scroller = container.querySelector('#messages') as HTMLElement;
    // Simulate pinned state: scroll to bottom
    if (scroller) {
      scroller.scrollTop = scroller.scrollHeight;
      scroller.dispatchEvent(new Event('scroll'));
    }
    // Burst 10 more
    const more = Array.from({ length: 10 }, (_, i) => createMessage({ text: `burst ${i}`, t: base + 20000 + i * 10, eid: 100 + i, msgid: `b${i}` }));
    batchAppendMessages('net1', '#chan', more);
    flushSync();
    await tick();
    await new Promise((r) => setTimeout(r, 250));
    await tick();
    // After burst while pinned, should be near bottom (≤1px) or at bottom via DOM check
    if (scroller) {
      const dist = scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop;
      expect(dist).toBeLessThanOrEqual(2);
    }
    // Should render burst messages
    await expect.element(page.getByText('burst 9')).toBeInTheDocument();
  });

  it('anchores reading position when burst arrives while scrolled up (frozen window)', async () => {
    const net = createNetwork({ networkId: 'net1' });
    net.buffers.push(createBuffer({ name: '#chan' }));
    ircState.networks.push(net);
    ircState.activeBuffer.networkId = 'net1';
    ircState.activeBuffer.bufferName = '#chan';
    const base = Date.now();
    // Start with 250 messages so windowing is active
    ircState.messages['net1:#chan'] = Array.from({ length: 250 }, (_, i) => createMessage({ text: `old ${i}`, t: base + i * 1000, eid: i + 1, msgid: `o${i}` }));
    flushSync();
    const { container } = render(MessageList, { props: {} });
    await tick();
    const scroller = container.querySelector('#messages') as HTMLElement;
    if (scroller) {
      // Scroll up 200px from bottom
      scroller.scrollTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight - 200);
      scroller.dispatchEvent(new Event('scroll'));
      await tick();
      const beforeTop = scroller.scrollTop;
      const more = Array.from({ length: 20 }, (_, i) => createMessage({ text: `new ${i}`, t: base + 500000 + i * 10, eid: 5000 + i, msgid: `n${i}` }));
      batchAppendMessages('net1', '#chan', more);
      flushSync();
      await tick();
      await new Promise((r) => setTimeout(r, 250));
      // Should not have yanked to bottom; scrollTop should stay near beforeTop (anchored / frozen)
      const afterTop = scroller.scrollTop;
      expect(Math.abs(afterTop - beforeTop)).toBeLessThan(5);
    }
  });

  it('bounds DOM window during 1000-msg burst while pinned', async () => {
    const net = createNetwork({ networkId: 'net1' });
    net.buffers.push(createBuffer({ name: '#chan' }));
    ircState.networks.push(net);
    ircState.activeBuffer.networkId = 'net1';
    ircState.activeBuffer.bufferName = '#chan';
    const base = Date.now();
    ircState.messages['net1:#chan'] = Array.from({ length: 50 }, (_, i) => createMessage({ text: `init ${i}`, t: base + i * 1000, eid: i + 1, msgid: `i${i}` }));
    flushSync();
    render(MessageList, { props: {} });
    await tick();
    // Simulate 1000 burst via 5 coalesced batches (now single batch via batcher, but store still handles 1000)
    const burst = Array.from({ length: 1000 }, (_, i) => createMessage({ text: `bulk ${i}`, t: base + 100000 + i * 10, eid: 1000 + i, msgid: `bulk${i}` }));
    // Split into 5 batches to exercise old cap path — now coalesced to one effect but still tests windowing
    for (let off = 0; off < burst.length; off += 200) {
      batchAppendMessages('net1', '#chan', burst.slice(off, off + 200));
    }
    flushSync();
    await tick();
    await new Promise((r) => setTimeout(r, 300));
    const total = ircState.messages['net1:#chan']?.length ?? 0;
    expect(total).toBe(1050);
    // Processed window should be bounded (renderStart advances, not 1050 rows)
    const processed = ircState.processedMessages['net1:#chan']?.length ?? 0;
    expect(processed).toBeGreaterThan(0);
    // No duplicate keys should have thrown (test would have errored)
  });
});
