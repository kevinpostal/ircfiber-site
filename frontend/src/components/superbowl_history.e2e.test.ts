// DB-BACKED INTEGRATION SUITE — needs the full local stack, not just vitest.
//
// It asserts the dev-stack `admin` login actually succeeds (POST /login) before
// driving the MessageList scroll-back, so it only means anything when the IRC
// Fiber gateway is reachable through the Vite proxy on 127.0.0.1:8090
// (vite.config.ts BACKEND_URL).
//
// Run it for real:
//   1. start the backing services + gateway (see skill://ircfiber-native-smoke-stack,
//      or `make debug` for the colima stack on 127.0.0.1:8090)
//   2. cd site/frontend
//      npx vitest run --project=client src/components/superbowl_history.e2e.test.ts
//   (point elsewhere with VITE_BACKEND_URL=http://host:port, same var the dev
//    server uses.)
//
// Without that stack the suite SKIPS via the shared gatewayAvailable() probe
// instead of failing on ECONNREFUSED.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { flushSync } from 'svelte';
import MessageList from './MessageList.svelte';
import { createMessage, createNetwork, createBuffer } from '../test/factories';
import { ircState, prependMessages } from '../stores/ircStore.svelte';
import { clearedAtMap } from '../stores/preferences.svelte';
import { e2eReady, loginE2E, E2E_SKIP_REASON } from '../test/backendProbe';

const e2eUp = await e2eReady();

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

describe.skipIf(!e2eUp)(`superbowl history scroll (${E2E_SKIP_REASON})`, () => {
  beforeEach(reset);

  it('can scroll all the way to start without snapping to bottom', async () => {
    // The dev-stack login (VITE_E2E_USER/PASSWORD) – used for the history fetch
    expect(await loginE2E()).toBe(true);

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
