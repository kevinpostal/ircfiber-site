// DB-BACKED INTEGRATION SUITE — needs the full local stack, not just vitest.
//
// It logs in as the dev-stack `admin` user, resolves the "Super Nets" network
// (name, or host irc.supernets.org) from /api/networks and asserts real
// #superbowl history exists in Mongo/Redis before exercising the scroll-back
// anchor, so it only means anything when the IRC Fiber gateway is reachable
// through the Vite proxy on 127.0.0.1:8090 (vite.config.ts BACKEND_URL).
//
// Run it for real:
//   1. start the backing services + gateway (see skill://ircfiber-native-smoke-stack,
//      or `make debug` for the colima stack on 127.0.0.1:8090)
//   2. cd site/frontend
//      npx vitest run --project=client src/components/yesterday_scroll.e2e.test.ts
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

describe.skipIf(!gatewayUp)(`yesterday scroll - real DB (${GATEWAY_SKIP_REASON})`, () => {
  beforeEach(reset);
  it('finds yesterdays message in DB and scrolls back to see it', async () => {
    // Use .env creds
    await fetch('/login', { method: 'POST', headers: {'Content-Type':'application/x-www-form-urlencoded'}, body: new URLSearchParams({username:'admin', password:'REDACTED'} as any), credentials:'include' });
    const nets: any = await fetch('/api/networks', {credentials:'include'}).then(r=>r.json());
    const superNet = nets.find((n:any) => n.name === 'Super Nets' || n.host === 'irc.supernets.org');
    expect(superNet).toBeDefined();
    const netId = superNet.id;
    const buf = '#superbowl';
    // Verify DB has history (like yesterday)
    const res = await loadHistoryWithMeta(netId, buf, { count: 100 });
    console.log('DB check', res.messages.length, 'backlog', res.backlog_size, 'oldest', res.messages[0] ? new Date((res.messages[0] as any).t).toISOString() : 'none');
    expect(res.messages.length).toBeGreaterThan(0);
    expect(res.backlog_size).toBeGreaterThan(0);
    // Now test scroll preservation with mock that mimics yesterday
    // Create mock history where yesterdayMsg is oldest and not in initial 50
    const now = Date.now();
    const yesterdayTime = now - 24*60*60*1000;
    const mockAll: any[] = [];
    for (let i=0; i<300; i++) {
      const t = yesterdayTime - (300-i)*60000; // 300 messages, oldest is yesterday
      mockAll.push({ text: `mock-${i}`, t, msgid: `mock-${i}`, eid: 1000000+i, nick: 'user', command: 'PRIVMSG', params: [buf, `mock-${i}`] });
    }
    const yesterdayMsg = mockAll[0];
    console.log('mock yesterday', yesterdayMsg.msgid, new Date(yesterdayMsg.t).toISOString());
    const initialWindow = mockAll.slice(-50);
    console.log('initialWindow', initialWindow[0].msgid, initialWindow[initialWindow.length-1].msgid);
    const net = createNetwork({ networkId: netId });
    net.buffers.push(createBuffer({ name: buf, type: 'channel' }));
    ircState.networks.push(net);
    ircState.activeBuffer.networkId = netId;
    ircState.activeBuffer.bufferName = buf;
    ircState.messages[`${netId}:${buf}`] = initialWindow;
    flushSync();
    const onLoadMore = async () => {
      const key = `${netId}:${buf}`;
      const existing = ircState.messages[key] ?? [];
      if (existing.length === 0) return false;
      // Find oldest in existing and prepend older from mockAll
      const first: any = existing[0];
      const idx = mockAll.findIndex(m => m.eid === first.eid);
      if (idx <= 0) return false;
      const start = Math.max(0, idx - 100);
      const older = mockAll.slice(start, idx);
      if (older.length > 0) {
        prependMessages(netId, buf, older);
        return true;
      }
      return false;
    };
    render(MessageList, { props: { onLoadMore } as any });
    flushSync();
    await new Promise(r => requestAnimationFrame(r));
    await new Promise(r => setTimeout(r, 300));
    const c = document.getElementById('messages') as HTMLDivElement;
    expect(c).not.toBeNull();
    c.style.height = '400px';
    c.style.overflowY = 'auto';
    await new Promise(r => requestAnimationFrame(r));
    await new Promise(r => setTimeout(r, 300));
    const isYesterdayVisible = () => {
      const rows = Array.from(document.querySelectorAll('.row.messageRow')) as HTMLElement[];
      return rows.some(el => (el as any).dataset.msgid === yesterdayMsg.msgid);
    };
    expect(isYesterdayVisible()).toBe(false);
    let found = false;
    let iterations = 0;
    while (!found && iterations < 10) {
      c.scrollTop = 0;
      c.dispatchEvent(new Event('scroll'));
      await new Promise(r => setTimeout(r, 900));
      await new Promise(r => requestAnimationFrame(r));
      const distAfter = c.scrollHeight - c.scrollTop - c.clientHeight;
      expect(distAfter > 100, `iter ${iterations} should not be at bottom`).toBe(true);
      found = isYesterdayVisible();
      console.log(`iter ${iterations} found`, found, 'dist', distAfter);
      if (found) break;
      iterations++;
    }
    expect(found, `yesterdays mock ${new Date(yesterdayMsg.t).toISOString()} should be visible`).toBe(true);
    expect(c.scrollHeight - c.scrollTop - c.clientHeight > 100).toBe(true);
  }, 25000);
});
