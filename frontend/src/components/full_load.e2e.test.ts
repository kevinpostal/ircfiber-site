// DB-BACKED INTEGRATION SUITE — needs the full local stack, not just vitest.
//
// It logs in as the dev-stack `admin` user, resolves the "Super Nets" network
// from /api/networks and pages real #superbowl history out of Mongo/Redis, so
// it only means anything when the IRC Fiber gateway is reachable through the
// Vite proxy on 127.0.0.1:8090 (vite.config.ts BACKEND_URL).
//
// Run it for real:
//   1. start the backing services + gateway (see skill://ircfiber-native-smoke-stack,
//      or `make debug` for the colima stack on 127.0.0.1:8090)
//   2. cd site/frontend
//      npx vitest run --project=client src/components/full_load.e2e.test.ts
//   (point elsewhere with VITE_BACKEND_URL=http://host:port, same var the dev
//    server uses.)
//
// Without that stack the suite SKIPS via the shared gatewayAvailable() probe
// instead of failing on ECONNREFUSED.
import { describe, it, expect, beforeEach } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { flushSync } from 'svelte';
import MessageList from './MessageList.svelte';
import { createNetwork, createBuffer } from '../test/factories';
import { ircState, prependMessages } from '../stores/ircStore.svelte';
import { loadHistoryWithMeta } from '../stores/api';
import { clearedAtMap } from '../stores/preferences.svelte';
import { gatewayAvailable, GATEWAY_SKIP_REASON } from '../test/backendProbe';

const gatewayUp = await gatewayAvailable();

function reset() {
  ircState.networks.length = 0;
  ircState.activeBuffer.networkId = null;
  ircState.activeBuffer.bufferName = null;
  ircState.messages = {};
  ircState.processedMessages = {};
  ircState.optimisticMessages.clear();
  ircState.backlogDivider = {};
}

describe.skipIf(!gatewayUp)(`full load to start (${GATEWAY_SKIP_REASON})`, () => {
  beforeEach(reset);
  it('can load all backlog to start via paging', async () => {
    await fetch('/login', { method: 'POST', headers: {'Content-Type':'application/x-www-form-urlencoded'}, body: new URLSearchParams({username:'admin', password:'REDACTED'} as any), credentials:'include' });
    const nets: any = await fetch('/api/networks', {credentials:'include'}).then(r=>r.json());
    const superNet = nets.find((n:any) => n.name === 'Super Nets');
    expect(superNet).toBeDefined();
    const netId = superNet.id;
    const buf = '#superbowl';
    const first = await loadHistoryWithMeta(netId, buf, { count: 100 });
    expect(first.messages.length).toBeGreaterThan(0);
    expect(first.backlog_size).toBeGreaterThan(first.messages.length);
    // Now test MessageList scroll with svelte-infinite
    const res = await loadHistoryWithMeta(netId, buf, { count: 200 });
    let allMessages: any[] = res.messages;
    const net = createNetwork({ networkId: netId });
    net.buffers.push(createBuffer({ name: buf, type: 'channel' }));
    ircState.networks.push(net);
    ircState.activeBuffer.networkId = netId;
    ircState.activeBuffer.bufferName = buf;
    // Start with most recent 100
    const initial = allMessages.slice(-100);
    ircState.messages[`${netId}:${buf}`] = initial;
    flushSync();
    const onLoadMore = async () => {
      const key = `${netId}:${buf}`;
      const existing = ircState.messages[key] ?? [];
      if (existing.length === 0) return false;
      const first: any = existing[0];
      const res2 = await loadHistoryWithMeta(netId, buf, { before: first.t, beforeid: first.eid ? String(first.eid) : undefined, beforeMsgid: first.msgid, count: 100 });
      if (res2.messages.length > 0) {
        const beforeLen = existing.length;
        prependMessages(netId, buf, res2.messages);
        return (ircState.messages[key] ?? []).length > beforeLen;
      }
      return false;
    };
    render(MessageList, { props: { onLoadMore } as any });
    flushSync();
    await new Promise(r=>requestAnimationFrame(r));
    await new Promise(r=>setTimeout(r, 300));
    const c = document.getElementById('messages') as HTMLDivElement;
    c.style.height='400px'; c.style.overflowY='auto';
    await new Promise(r=>setTimeout(r, 300));
    // Scroll to top 5 times, each should load more and not snap to bottom
    for(let i=0;i<5;i++) {
      c.scrollTop=0; c.dispatchEvent(new Event('scroll'));
      await new Promise(r=>setTimeout(r, 1000));
      const dist = c.scrollHeight - c.scrollTop - c.clientHeight;
      expect(dist > 100, `iter ${i} dist ${dist} should not be at bottom`).toBe(true);
    }
    // After 5 loads, we should have more than initial 100
    expect((ircState.messages[`${netId}:${buf}`] ?? []).length).toBeGreaterThan(100);
  }, 25000);
});
