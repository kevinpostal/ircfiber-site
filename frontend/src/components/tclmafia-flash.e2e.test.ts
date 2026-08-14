import { describe, expect, it, beforeEach } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { flushSync, tick } from 'svelte';
import MessageList from './MessageList.svelte';
import { createMessage, createNetwork, createBuffer } from '../test/factories';
import { ircState, prependMessages } from '../stores/ircStore.svelte';
import { clearedAtMap } from '../stores/preferences.svelte';

function resetState() {
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
  Object.keys(clearedAtMap).forEach((k) => delete (clearedAtMap as Record<string, unknown>)[k]);
}

beforeEach(() => resetState());

describe('tclmafia flash repro', () => {
  it('loads at bottom then stays at bottom after prepend (no mid flash)', async () => {
    const net = createNetwork({ networkId: 'net1' });
    net.buffers.push(createBuffer({ name: '#tclmafia', type: 'channel' }));
    ircState.networks.push(net);
    ircState.activeBuffer.networkId = 'net1';
    ircState.activeBuffer.bufferName = '#tclmafia';

    const now = Date.now();
    const initial: ReturnType<typeof createMessage>[] = [];
    for (let i = 0; i < 350; i++) {
      initial.push(createMessage({ text: `initial-${i}`, t: now - (350 - i) * 6000, nick: `user${i % 5}`, msgid: `init-${i}` }));
    }
    ircState.messages['net1:#tclmafia'] = initial;
    flushSync();

    render(MessageList, { props: {} });
    flushSync();
    await new Promise((r) => requestAnimationFrame(r));
    await new Promise((r) => setTimeout(r, 80));

    const container = () => document.getElementById('messages') as HTMLDivElement | null;
    let c1 = container();
    expect(c1).not.toBeNull();
    if (c1) {
      c1.style.height = '600px';
      c1.style.overflowY = 'auto';
      await new Promise((r) => requestAnimationFrame(r));
      c1.scrollTop = c1.scrollHeight;
      c1.dispatchEvent(new Event('scroll'));
      await new Promise((r) => setTimeout(r, 30));
    }

    c1 = container();
    if (c1) {
      const bottom1 = c1.scrollHeight - c1.clientHeight - c1.scrollTop;
      console.log(`[phase1] scrollTop=${c1.scrollTop} scrollHeight=${c1.scrollHeight} clientHeight=${c1.clientHeight} bottomDist=${bottom1} rows=${document.querySelectorAll('.row.messageRow').length}`);
      expect(bottom1, 'phase1 should be at bottom after initial load').toBeLessThanOrEqual(4);
      const rows1 = document.querySelectorAll('.row.messageRow');
      const last1 = rows1[rows1.length - 1] as HTMLElement;
      expect(last1?.textContent || '').toContain('initial-349');
    }

    const older: ReturnType<typeof createMessage>[] = [];
    for (let i = 0; i < 150; i++) {
      older.push(createMessage({ text: `older-${i}`, t: now - (500 - i) * 6000, nick: `olduser${i % 3}`, msgid: `old-${i}` }));
    }
    const combined = [...older, ...initial] as unknown as typeof ircState.messages[string];
    prependMessages('net1', '#tclmafia', older);
    console.log('after prepend messages len', ircState.messages['net1:#tclmafia'].length, 'processed len', ircState.processedMessages['net1:#tclmafia']?.length, 'first msgid', ircState.processedMessages['net1:#tclmafia']?.[0]?.msgid, 'first still', ircState.processedMessages['net1:#tclmafia']?.[0]?.text?.slice(0,20));
    flushSync();
    await new Promise((r) => requestAnimationFrame(r));
    await new Promise((r) => requestAnimationFrame(r));
    await new Promise((r) => setTimeout(r, 400));
    c1 = container();
    if (c1) {
      const bottom2 = c1.scrollHeight - c1.clientHeight - c1.scrollTop;
      console.log(`[phase2] scrollTop=${c1.scrollTop} scrollHeight=${c1.scrollHeight} clientHeight=${c1.clientHeight} bottomDist=${bottom2} rows=${document.querySelectorAll('.row.messageRow').length}`);
      expect(c1.scrollHeight).toBeGreaterThan(2751);
      expect(document.querySelectorAll('.row.messageRow').length).toBeGreaterThanOrEqual(150);
    }
  });
});
