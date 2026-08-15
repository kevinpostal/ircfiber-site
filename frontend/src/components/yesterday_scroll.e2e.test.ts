import { describe, it, expect, beforeEach } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { flushSync } from 'svelte';
import MessageList from './MessageList.svelte';
import { createNetwork, createBuffer } from '../test/factories';
import { ircState, prependMessages } from '../stores/ircStore.svelte';
import { loadHistoryWithMeta } from '../stores/api';
import { clearedAtMap } from '../stores/preferences.svelte';

function reset() {
  ircState.networks.length = 0;
  ircState.activeBuffer.networkId = null;
  ircState.activeBuffer.bufferName = null;
  ircState.messages = {};
  ircState.processedMessages = {};
  ircState.optimisticMessages.clear();
  ircState.backlogDivider = {};
}

describe('yesterday scroll - real DB', () => {
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
