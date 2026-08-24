import { describe, it, expect, beforeEach } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { flushSync } from 'svelte';
import MessageList from './MessageList.svelte';
import { createMessage, createNetwork, createBuffer } from '../test/factories';
import { ircState } from '../stores/ircStore.svelte';
import { clearedAtMap } from '../stores/preferences.svelte';

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

describe('arrow 20', () => {
  beforeEach(reset);
  it('20 ArrowUp does not jump back down', async () => {
    const net = createNetwork({ networkId: 'net1' });
    net.buffers.push(createBuffer({ name: '#chan', type: 'channel' }));
    ircState.networks.push(net);
    ircState.activeBuffer.networkId = 'net1';
    ircState.activeBuffer.bufferName = '#chan';
    const now = Date.now();
    const msgs = [];
    for (let i = 0; i < 1000; i++) msgs.push(createMessage({ text: `msg-${i}`, t: now - (1000 - i) * 1000, msgid: `m-${i}`, eid: 1000 + i, nick: 'user' }));
    ircState.messages['net1:#chan'] = msgs;
    flushSync();
    render(MessageList, { props: {} });
    flushSync();
    await nextFrame();
    await delay(300);
    const c = document.getElementById('messages') as HTMLDivElement | null;
    expect(c).not.toBeNull();
    if (!c) return;
    c.style.height = '400px';
    c.style.overflowY = 'auto';
    await nextFrame();
    await delay(200);
    expect(Math.abs(c.scrollHeight - c.scrollTop - c.clientHeight) <= 5).toBe(true);
    const tops: number[] = [];
    for (let i = 0; i < 20; i++) {
      const beforeTop = c.scrollTop;
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
      // MessageList handler already scrolls 40; do not add manual extra scroll
      await delay(20);
      await nextFrame();
      const afterTop = c.scrollTop;
      tops.push(afterTop);
      if (i >= 15) {
        const diff = beforeTop - afterTop;
        expect(diff, `iter ${i} diff ${diff} should be 30-50`).toBeGreaterThan(20);
        expect(diff).toBeLessThan(60);
        expect(afterTop < beforeTop, `iter ${i} afterTop ${afterTop} < beforeTop ${beforeTop}`).toBe(true);
      }
      expect(c.scrollHeight - c.scrollTop - c.clientHeight > 20).toBe(true);
    }
    for (let i = 1; i < tops.length; i++) {
      expect(tops[i] < tops[i-1], `tops[${i}] ${tops[i]} < tops[${i-1}] ${tops[i-1]}`).toBe(true);
    }
    // now scroll to top to trigger history reveal
    const midTopBeforeReveal = c.scrollTop;
    c.scrollTop = 0;
    c.dispatchEvent(new Event('scroll'));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    await delay(150);
    await nextFrame();
    const afterRevealTop = c.scrollTop;
    const distAfterReveal = c.scrollHeight - c.scrollTop - c.clientHeight;
    expect(distAfterReveal > 100, `after top reveal dist ${distAfterReveal} >100`).toBe(true);
    expect(afterRevealTop > 0, `after top reveal scrollTop ${afterRevealTop} >0`).toBe(true);
    expect(afterRevealTop < 4000, `after top reveal scrollTop ${afterRevealTop} <4000`).toBe(true);
    expect(afterRevealTop !== 0, `after top reveal not still at 0`).toBe(true);
    // new message while reading at half-way should not snap
    const midTop2 = c.scrollTop;
    const newMsg = createMessage({ text: 'new while reading', t: Date.now(), msgid: 'm-new', eid: 9999, nick: 'other' });
    ircState.messages['net1:#chan'] = [...(ircState.messages['net1:#chan'] ?? []), newMsg];
    flushSync();
    await delay(100);
    await nextFrame();
    expect(Math.abs(c.scrollTop - midTop2) < 30, `not snapped after new msg: ${c.scrollTop} vs ${midTop2}`).toBe(true);
  }, 15000);
});
