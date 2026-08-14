import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { flushSync } from 'svelte';
import MessageList from './MessageList.svelte';
import { createMessage, createNetwork, createBuffer } from '../test/factories';
import { ircState, prependMessages } from '../stores/ircStore.svelte';
import { clearedAtMap } from '../stores/preferences.svelte';

function reset() {
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
  Object.keys(clearedAtMap).forEach(k => delete (clearedAtMap as Record<string, any>)[k]);
}

describe('superbowl history scroll', () => {
  beforeEach(reset);

  it('can scroll all the way to start without snapping to bottom', async () => {
    // Verify .env creds work (admin/REDACTED) – used for e2e history fetch
    const loginRes = await fetch('/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ username: 'admin', password: 'REDACTED' } as any),
      credentials: 'include',
    });
    expect(loginRes.ok || loginRes.status === 302).toBe(true);

    const net = createNetwork({ networkId: 'net1' });
    net.buffers.push(createBuffer({ name: '#superbowl', type: 'channel' }));
    ircState.networks.push(net);
    ircState.activeBuffer.networkId = 'net1';
    ircState.activeBuffer.bufferName = '#superbowl';
    const now = Date.now();
    const initial = [];
    for (let i = 0; i < 1000; i++) {
      initial.push(createMessage({ text: `msg-${i} ` + 'x'.repeat(20), t: now - (1000 - i) * 1000, msgid: `m-${i}`, eid: 1000 + i, nick: 'user' }));
    }
    ircState.messages['net1:#superbowl'] = initial;
    flushSync();

    const onLoadMore = vi.fn(async () => {
      const oldest = ircState.messages['net1:#superbowl'][0];
      const oldestEid = oldest.eid ?? 1000;
      if (oldestEid <= 0) return false;
      const older = [];
      for (let i = 0; i < 100; i++) {
        const eid = oldestEid - 100 + i;
        older.push(createMessage({ text: `older-${eid}`, t: now - (2000 - eid) * 1000, msgid: `m-${eid}`, eid, nick: 'user' }));
      }
      prependMessages('net1', '#superbowl', older);
      return true;
    });

    render(MessageList, { props: { onLoadMore } as any });
    flushSync();
    await new Promise(r => requestAnimationFrame(r));
    await new Promise(r => setTimeout(r, 100));
    const c = document.getElementById('messages') as HTMLDivElement;
    expect(c).not.toBeNull();
    c.style.height = '400px';
    c.style.overflowY = 'auto';
    await new Promise(r => requestAnimationFrame(r));
    await new Promise(r => setTimeout(r, 300));
    expect(Math.abs(c.scrollHeight - c.scrollTop - c.clientHeight) <= 5).toBe(true);

    for (let iter = 0; iter < 8; iter++) {
      c.scrollTop = 0;
      c.dispatchEvent(new Event('scroll'));
      await new Promise(r => setTimeout(r, 600));
      await new Promise(r => requestAnimationFrame(r));
      const distBottom = c.scrollHeight - c.scrollTop - c.clientHeight;
      expect(distBottom > 100).toBe(true);
    }
    c.scrollTop = 0;
    c.dispatchEvent(new Event('scroll'));
    await new Promise(r => setTimeout(r, 600));
    expect(c.scrollHeight - c.scrollTop - c.clientHeight > 100).toBe(true);
  }, 15000);
});
