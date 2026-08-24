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

describe('arrow skip', () => {
  beforeEach(reset);
  it('arrow up from bottom does not skip 200 lines', async () => {
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
    await delay(200);
    expect(Math.abs(c.scrollHeight - c.scrollTop - c.clientHeight) <= 5).toBe(true);
    const getTopVisibleId = (): string | null => {
      const rows = Array.from(document.querySelectorAll('.row.messageRow')) as HTMLElement[];
      const cRect = c.getBoundingClientRect();
      for (const r of rows) {
        const rect = r.getBoundingClientRect();
        if (rect.bottom > cRect.top + 5 && rect.top < cRect.bottom - 5) return r.dataset.msgid ?? null;
      }
      return rows[0]?.dataset.msgid ?? null;
    };
    const getTopVisibleNum = (id: string | null): number => id ? parseInt(id.replace('m-', ''), 10) : -1;
    let prevTopId = getTopVisibleId();
    let prevNum = getTopVisibleNum(prevTopId);
    expect(prevTopId).not.toBeNull();
    for (let i = 0; i < 20; i++) {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
      c.scrollTop = Math.max(0, c.scrollTop - 40);
      c.dispatchEvent(new Event('scroll'));
      await delay(60);
      await nextFrame();
      const topAfter = getTopVisibleId();
      const afterNum = getTopVisibleNum(topAfter);
      const diff = prevNum - afterNum;
      expect(diff).toBeGreaterThanOrEqual(0);
      expect(diff).toBeLessThan(10);
      prevTopId = topAfter;
      prevNum = afterNum;
      expect(c.scrollHeight - c.scrollTop - c.clientHeight > 20).toBe(true);
    }
  }, 15000);
});
