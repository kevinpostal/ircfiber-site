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
  for (const k of Object.keys(clearedAtMap)) {
    // clearedAtMap is Record<string, number> — delete via index
    delete (clearedAtMap as Record<string, number>)[k];
  }
}

describe('arrow keys and snap', () => {
  beforeEach(reset);

  it('snaps to bottom on load', async () => {
    const net = createNetwork({ networkId: 'net1' });
    net.buffers.push(createBuffer({ name: '#chan', type: 'channel' }));
    ircState.networks.push(net);
    ircState.activeBuffer.networkId = 'net1';
    ircState.activeBuffer.bufferName = '#chan';
    const now = Date.now();
    const msgs = [];
    for (let i = 0; i < 600; i++) msgs.push(createMessage({ text: `msg-${i}`, t: now - (600 - i) * 1000, msgid: `m-${i}`, eid: 1000 + i, nick: 'user' }));
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
    await delay(300);
    const dist = c.scrollHeight - c.scrollTop - c.clientHeight;
    expect(Math.abs(dist) <= 5).toBe(true);
    await delay(100);
  }, 15000);

  it('arrowUp slowly scrolls and does not snap back', async () => {
    const net = createNetwork({ networkId: 'net1' });
    net.buffers.push(createBuffer({ name: '#chan', type: 'channel' }));
    ircState.networks.push(net);
    ircState.activeBuffer.networkId = 'net1';
    ircState.activeBuffer.bufferName = '#chan';
    const now = Date.now();
    const msgs = [];
    for (let i = 0; i < 600; i++) msgs.push(createMessage({ text: `msg-${i} lorem`, t: now - (600 - i) * 1000, msgid: `m-${i}`, eid: 1000 + i, nick: 'user' }));
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

    // slowly arrow up 5 times — each ArrowUp should clear stick and scroll 40-80px, staying not at bottom
    for (let i = 0; i < 5; i++) {
      const beforeTop = c.scrollTop;
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
      c.scrollTop = Math.max(0, c.scrollTop - 80);
      c.dispatchEvent(new Event('scroll'));
      await delay(80);
      await nextFrame();
      const afterTop = c.scrollTop;
      const afterDist = c.scrollHeight - c.scrollTop - c.clientHeight;
      expect(afterTop < beforeTop).toBe(true);
      expect(afterDist > 20).toBe(true);
      expect(Math.abs(c.scrollHeight - c.scrollTop - c.clientHeight) > 20).toBe(true);
    }
    const midTop = c.scrollTop;
    for (let i = 0; i < 3; i++) {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
      await delay(30);
    }
    // handler now scrolls 40 per press, so mid has moved up ~120
    await nextFrame();
    const midTop2 = c.scrollTop;
    expect(midTop2 < midTop, `3 extra ups must move further up`).toBe(true);
    expect(Math.abs(midTop2 - (midTop - 120)) < 40, `3 ups should move ~120, got ${midTop - midTop2}`).toBe(true);
    const newMsg = createMessage({ text: 'new while reading', t: Date.now(), msgid: 'm-new', eid: 9999, nick: 'other' });
    const key = 'net1:#chan';
    ircState.messages[key] = [...(ircState.messages[key] ?? []), newMsg];
    flushSync();
    await delay(100);
    await nextFrame();
    expect(Math.abs(c.scrollTop - midTop2) < 30, `must not snap after new msg`).toBe(true);
    expect(c.scrollHeight - c.scrollTop - c.clientHeight > 20).toBe(true);
});
});
