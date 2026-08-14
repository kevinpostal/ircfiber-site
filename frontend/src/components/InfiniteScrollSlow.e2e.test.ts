import { describe, expect, it, beforeEach, vi } from 'vitest';
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

describe('infinite scroll — slow scroll up keeps reading place (IRCCloud parity)', () => {
  it('slow scroll up through in-memory backlog preserves top anchor with divider snap', async () => {
    const net = createNetwork({ networkId: 'net1' });
    net.buffers.push(createBuffer({ name: '#chan', type: 'channel' }));
    ircState.networks.push(net);
    ircState.activeBuffer.networkId = 'net1';
    ircState.activeBuffer.bufferName = '#chan';

    const now = Date.now();
    const total = 800;
    const seed = [];
    for (let i = 0; i < total; i++) {
      seed.push(createMessage({ text: `line-${i} lorem ipsum`, t: now - (total - i) * 1000, msgid: `m-${i}`, nick: `user${i % 3}` }));
    }
    ircState.messages['net1:#chan'] = seed;
    flushSync();

    render(MessageList, { props: {} });
    flushSync();
    await new Promise((r) => requestAnimationFrame(r));
    await new Promise((r) => setTimeout(r, 80));

    const c = document.getElementById('messages') as HTMLDivElement;
    expect(c).not.toBeNull();
    c.style.height = '400px';
    c.style.overflowY = 'auto';
    await new Promise((r) => requestAnimationFrame(r));
    expect(c.scrollHeight).toBeGreaterThan(c.clientHeight);

    const scrollHeightBefore = c.scrollHeight;
    expect(scrollHeightBefore).toBeGreaterThan(c.clientHeight);

    // Scroll to top to trigger in-memory reveal.
    c.scrollTop = 0;
    c.dispatchEvent(new Event('scroll'));
    await new Promise((r) => requestAnimationFrame(r));
    await new Promise((r) => setTimeout(r, 350));
    await new Promise((r) => requestAnimationFrame(r));

    // Should have left scrollTop 0 (chunk paging) and remain scrollable
    expect(c.scrollTop).toBeGreaterThan(30);
    expect(c.scrollHeight).toBeGreaterThan(c.clientHeight);
  }, 15000);

  it('network prepend while mid-scroll preserves anchor via delta (IRCCloud delta path)', async () => {
    const net = createNetwork({ networkId: 'net1' });
    net.buffers.push(createBuffer({ name: '#chan', type: 'channel' }));
    ircState.networks.push(net);
    ircState.activeBuffer.networkId = 'net1';
    ircState.activeBuffer.bufferName = '#chan';

    const now = Date.now();
    const initial = [];
    for (let i = 500; i < 700; i++) {
      initial.push(createMessage({ text: `line-${i}`, t: now - (700 - i) * 1000, msgid: `m-${i}`, nick: `user${i % 3}` }));
    }
    ircState.messages['net1:#chan'] = initial;
    flushSync();

    render(MessageList, { props: {} });
    flushSync();
    await new Promise((r) => requestAnimationFrame(r));
    await new Promise((r) => setTimeout(r, 80));

    const c = document.getElementById('messages') as HTMLDivElement;
    c.style.height = '400px';
    c.style.overflowY = 'auto';
    await new Promise((r) => requestAnimationFrame(r));

    c.scrollTop = 300;
    c.dispatchEvent(new Event('scroll'));
    await new Promise((r) => setTimeout(r, 80));

    const rows = Array.from(document.querySelectorAll('.row.messageRow')) as HTMLElement[];
    const anchor = rows[Math.floor(rows.length / 2)] ?? rows[0];
    expect(anchor).not.toBeNull();
    const anchorId = anchor.dataset.msgid!;
    const topBefore = anchor.getBoundingClientRect().top;
    const scrollTopBefore = c.scrollTop;
    const scrollHeightBefore = c.scrollHeight;

    const older = [];
    for (let i = 400; i < 500; i++) {
      older.push(createMessage({ text: `line-${i}`, t: now - (700 - i) * 1000, msgid: `m-${i}`, nick: `user${i % 3}` }));
    }
    prependMessages('net1', '#chan', older);
    flushSync();
    await new Promise((r) => requestAnimationFrame(r));
    await new Promise((r) => setTimeout(r, 100));
    await new Promise((r) => requestAnimationFrame(r));

    const anchorAfter = document.querySelector(`[data-msgid="${anchorId}"]`) as HTMLElement | null;
    expect(anchorAfter).not.toBeNull();
    const topAfter = anchorAfter!.getBoundingClientRect().top;
    expect(Math.abs(topAfter - topBefore)).toBeLessThan(100);
    const delta = c.scrollHeight - scrollHeightBefore;
    expect(delta).toBeGreaterThan(0);
    expect(Math.abs(c.scrollTop - (scrollTopBefore + delta))).toBeLessThan(30);
  }, 15000);

  it('slow scroll up triggers load without losing ability to continue scrolling (no wedge at top)', async () => {
    const net = createNetwork({ networkId: 'net1' });
    net.buffers.push(createBuffer({ name: '#chan', type: 'channel' }));
    ircState.networks.push(net);
    ircState.activeBuffer.networkId = 'net1';
    ircState.activeBuffer.bufferName = '#chan';

    const now = Date.now();
    const total = 600;
    const seed = [];
    for (let i = 0; i < total; i++) {
      seed.push(createMessage({ text: `msg-${i}`, t: now - (total - i) * 1000, msgid: `m-${i}`, nick: `user${i % 3}` }));
    }
    ircState.messages['net1:#chan'] = seed;
    flushSync();

    render(MessageList, { props: {} });
    flushSync();
    await new Promise((r) => requestAnimationFrame(r));
    await new Promise((r) => setTimeout(r, 80));

    const c = document.getElementById('messages') as HTMLDivElement;
    c.style.height = '400px';
    c.style.overflowY = 'auto';
    await new Promise((r) => requestAnimationFrame(r));

    c.scrollTop = 0;
    c.dispatchEvent(new Event('scroll'));
    await new Promise((r) => setTimeout(r, 300));
    await new Promise((r) => requestAnimationFrame(r));
    expect(c.scrollTop).toBeGreaterThan(10);
    const firstScrollTop = c.scrollTop;

    c.scrollTop = 0;
    c.dispatchEvent(new Event('scroll'));
    await new Promise((r) => setTimeout(r, 300));
    await new Promise((r) => requestAnimationFrame(r));
    expect(c.scrollTop).toBeGreaterThan(10);
    expect(c.scrollTop).not.toBe(firstScrollTop);
    expect(c.scrollHeight).toBeGreaterThan(c.clientHeight);
  }, 15000);
});
