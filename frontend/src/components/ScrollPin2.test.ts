import { describe, expect, it, beforeEach } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import { flushSync, tick } from 'svelte';
import MessageList from './MessageList.svelte';
import { createNetwork, createBuffer, createMessage } from '../test/factories';
import { ircState, appendMessage, requestForceScrollToBottom } from '../stores/ircStore.svelte';
import { clearedAtMap } from '../stores/preferences.svelte';
import type { IRCMessage } from '../types';

function resetState(): void {
  ircState.networks.length = 0;
  ircState.activeBuffer.networkId = null;
  ircState.activeBuffer.bufferName = null;
  ircState.messages = {};
  ircState.processedMessages = {};
  ircState.backlogDivider = {};
  ircState.lastSeenMsgTime = null;
  ircState.focusLost = false;
  ircState.forceScrollToBottomNonce = 0;
  ircState.optimisticMessages.clear();
  Object.keys(clearedAtMap).forEach((k) => delete (clearedAtMap as Record<string, unknown>)[k]);
}

describe('Scroll pin 1-0 with overflow', () => {
  beforeEach(() => {
    resetState();
  });

  it('typing 1-0 keeps scroll at bottom, 0 last visible', async () => {
    const net = createNetwork({ networkId: 'net1', currentNick: 'tester' });
    net.buffers.push(createBuffer({ name: '#chan' }));
    ircState.networks.push(net);
    ircState.activeBuffer.networkId = 'net1';
    ircState.activeBuffer.bufferName = '#chan';
    flushSync();

    const now = Date.now();
    const initial: IRCMessage[] = [];
    for (let i = 0; i < 30; i++) {
      initial.push(createMessage({ text: `init-${i}`, t: now - (100 - i) * 1000, msgid: `init-${i}`, nick: 'tester' }));
    }
    ircState.messages['net1:#chan'] = initial;
    flushSync();

    render(MessageList, { props: {} });
    await tick();
    const container = () => document.getElementById('messages') as HTMLDivElement | null;
    const c0 = container();
    if (c0) {
      c0.style.height = '300px';
      c0.style.overflowY = 'auto';
    }
    await new Promise((r) => requestAnimationFrame(r));
    await new Promise((r) => setTimeout(r, 100));
    const cInit = container();
    if (cInit) {
      requestForceScrollToBottom();
      flushSync();
      await tick();
      await new Promise((r) => requestAnimationFrame(r));
      await new Promise((r) => setTimeout(r, 50));
    }

    const seq = ['1','2','3','4','5','6','7','8','9','0'];
    for (const ch of seq) {
      appendMessage('net1', '#chan', createMessage({ text: ch, t: Date.now(), msgid: `seq-${ch}-${Date.now()}`, nick: 'tester' }));
      requestForceScrollToBottom();
      flushSync();
      await tick();
      await new Promise((r) => requestAnimationFrame(r));
      await new Promise((r) => setTimeout(r, 80));
      await expect.element(page.getByText(ch).first()).toBeInTheDocument({ timeout: 2000 });
      const c = container();
      if (c && c.scrollHeight > c.clientHeight) {
        const atBottom = c.scrollHeight - c.clientHeight - c.scrollTop;
        expect(atBottom, `after ${ch} atBottom=${atBottom} scrollTop=${c.scrollTop} scrollHeight=${c.scrollHeight}`).toBeLessThanOrEqual(3);
      }
    }

    for (const ch of seq) {
      await expect.element(page.getByText(ch).first()).toBeInTheDocument();
    }
    const allRows = document.querySelectorAll('#messages [data-msgid], #messages .messageRow');
    const lastText = (allRows[allRows.length - 1] as HTMLElement)?.textContent || '';
    expect(lastText).toContain('0');

    const cFinal = container();
    if (cFinal) {
      console.log(`[scroll-pin2] final atBottom=${cFinal.scrollHeight - cFinal.clientHeight - cFinal.scrollTop} scrollTop=${cFinal.scrollTop} scrollHeight=${cFinal.scrollHeight} clientHeight=${cFinal.clientHeight}`);
      expect(cFinal.scrollHeight - cFinal.clientHeight - cFinal.scrollTop).toBeLessThanOrEqual(100);
      const zeroEl = page.getByText('0').first().element() as HTMLElement | null;
      if (zeroEl) {
        const rect = zeroEl.getBoundingClientRect();
        const cRect = cFinal.getBoundingClientRect();
        expect(rect.bottom).toBeLessThanOrEqual(cRect.bottom + 500);
        expect(rect.top).toBeGreaterThanOrEqual(cRect.top - 600);
      }
    }
  }, 20000);
});
