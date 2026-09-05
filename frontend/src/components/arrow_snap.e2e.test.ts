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

describe('snap to bottom', () => {
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
});
