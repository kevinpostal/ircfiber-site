import { describe, expect, it, beforeEach } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { flushSync, tick } from 'svelte';
import MessageList from './MessageList.svelte';
import { createNetwork, createBuffer, createMessage } from '../test/factories';
import { ircState, appendMessage, requestForceScrollToBottom } from '../stores/ircStore.svelte';
import { clearedAtMap } from '../stores/preferences.svelte';

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

describe('action snap', () => {
  beforeEach(() => resetState());

  it('snaps to bottom for /me action even when scrolled up (forceScroll)', async () => {
    const net = createNetwork({ networkId: 'net1' });
    net.buffers.push(createBuffer({ name: '#chan' }));
    ircState.networks.push(net);
    ircState.activeBuffer.networkId = 'net1';
    ircState.activeBuffer.bufferName = '#chan';

    const now = Date.now();
    const seed: ReturnType<typeof createMessage>[] = [];
    for (let i = 0; i < 40; i++) {
      seed.push(createMessage({ text: `seed-${i}`, t: now - (40 - i) * 1000, msgid: `seed-${i}` }));
    }
    ircState.messages['net1:#chan'] = seed;
    flushSync();

    render(MessageList, { props: {} });
    flushSync();
    await new Promise((r) => requestAnimationFrame(r));
    await new Promise((r) => setTimeout(r, 80));

    const container = () => document.getElementById('messages') as HTMLDivElement | null;
    let c = container();
    expect(c).not.toBeNull();
    if (!c) return;
    c.style.height = '300px';
    c.style.overflowY = 'auto';
    await new Promise((r) => requestAnimationFrame(r));
    // Pin to bottom initially
    c.scrollTop = c.scrollHeight;
    c.dispatchEvent(new Event('scroll'));
    await new Promise((r) => setTimeout(r, 30));
    expect(c.scrollHeight - c.clientHeight - c.scrollTop).toBeLessThan(4);

    // Scroll up 100px to simulate reading history
    c.scrollTop -= 100;
    c.dispatchEvent(new Event('scroll'));
    await new Promise((r) => setTimeout(r, 30));
    const scrolledTop = c.scrollTop;
    expect(c.scrollHeight - c.clientHeight - scrolledTop).toBeGreaterThan(50);

    // User does /me  (action) - should force scroll to bottom
    requestForceScrollToBottom();
    appendMessage('net1', '#chan', {
      command: 'PRIVMSG',
      nick: 'tester',
      type: 'action',
      text: 'does an action',
      t: Date.now(),
      msgid: 'action-1',
      timestamp: new Date().toISOString(),
      params: [],
      prefix: '',
    });
    flushSync();
    await new Promise((r) => requestAnimationFrame(r));
    await new Promise((r) => setTimeout(r, 100));

    // Should have snapped to bottom and show the action
    const drift = c.scrollHeight - c.clientHeight - c.scrollTop;
    expect(drift).toBeLessThan(4);
    // The action row should be visible
    const actionRow = document.querySelector('[data-msgid="action-1"]') as HTMLElement | null;
    // Fallback: check text
    const hasAction = !!actionRow || Array.from(document.querySelectorAll('.row.messageRow')).some(r => r.textContent?.includes('does an action'));
    expect(hasAction).toBe(true);
  });

  it('also snaps for NOTICE action-like messages when forceScrolled', async () => {
    const net = createNetwork({ networkId: 'net1' });
    net.buffers.push(createBuffer({ name: '#chan' }));
    ircState.networks.push(net);
    ircState.activeBuffer.networkId = 'net1';
    ircState.activeBuffer.bufferName = '#chan';

    const now = Date.now();
    const seed: ReturnType<typeof createMessage>[] = [];
    for (let i = 0; i < 40; i++) {
      seed.push(createMessage({ text: `seed-${i}`, t: now - (40 - i) * 1000, msgid: `seed-${i}` }));
    }
    ircState.messages['net1:#chan'] = seed;
    flushSync();

    render(MessageList, { props: {} });
    flushSync();
    await new Promise((r) => requestAnimationFrame(r));
    await new Promise((r) => setTimeout(r, 80));

    const c = document.getElementById('messages') as HTMLDivElement | null;
    expect(c).not.toBeNull();
    if (!c) return;
    c.style.height = '300px';
    await new Promise((r) => requestAnimationFrame(r));
    c.scrollTop = c.scrollHeight;
    c.dispatchEvent(new Event('scroll'));
    await new Promise((r) => setTimeout(r, 30));

    c.scrollTop -= 100;
    c.dispatchEvent(new Event('scroll'));
    await new Promise((r) => setTimeout(r, 30));

    requestForceScrollToBottom();
    appendMessage('net1', '#chan', {
      command: 'NOTICE',
      nick: 'tester',
      text: 'notice action',
      t: Date.now(),
      msgid: 'notice-1',
      timestamp: new Date().toISOString(),
      params: [],
      prefix: '',
    });
    flushSync();
    await new Promise((r) => requestAnimationFrame(r));
    await new Promise((r) => setTimeout(r, 100));

    const drift = c.scrollHeight - c.clientHeight - c.scrollTop;
    expect(drift).toBeLessThan(4);
  });
  it('snaps for /me optimistic without type (InputArea style) when scrolled up', async () => {
    const net = createNetwork({ networkId: 'net1' });
    net.buffers.push(createBuffer({ name: '#chan' }));
    ircState.networks.push(net);
    ircState.activeBuffer.networkId = 'net1';
    ircState.activeBuffer.bufferName = '#chan';

    const now = Date.now();
    const seed: ReturnType<typeof createMessage>[] = [];
    for (let i = 0; i < 40; i++) {
      seed.push(createMessage({ text: `seed-${i}`, t: now - (40 - i) * 1000, msgid: `seed-${i}` }));
    }
    ircState.messages['net1:#chan'] = seed;
    flushSync();

    render(MessageList, { props: {} });
    flushSync();
    await new Promise((r) => requestAnimationFrame(r));
    await new Promise((r) => setTimeout(r, 80));

    const c = document.getElementById('messages') as HTMLDivElement | null;
    expect(c).not.toBeNull();
    if (!c) return;
    c.style.height = '300px';
    await new Promise((r) => requestAnimationFrame(r));
    c.scrollTop = c.scrollHeight;
    c.dispatchEvent(new Event('scroll'));
    await new Promise((r) => setTimeout(r, 30));

    c.scrollTop -= 100;
    c.dispatchEvent(new Event('scroll'));
    await new Promise((r) => setTimeout(r, 30));
    expect(c.scrollHeight - c.clientHeight - c.scrollTop).toBeGreaterThan(50);

    // InputArea optimistic for /me: text is CTCP ACTION, no type field, just PRIVMSG
    requestForceScrollToBottom();
    appendMessage('net1', '#chan', {
      command: 'PRIVMSG',
      nick: 'tester',
      text: '\x01ACTION does an action\x01',
      t: Date.now(),
      msgid: 'action-opt-1',
      timestamp: new Date().toISOString(),
      params: [],
      prefix: '',
    });
    flushSync();
    await new Promise((r) => requestAnimationFrame(r));
    await new Promise((r) => setTimeout(r, 100));

    const drift = c.scrollHeight - c.clientHeight - c.scrollTop;
    expect(drift).toBeLessThan(4);
  });
  it('snaps for incoming action/notice even without forceScroll when scrolled up', async () => {
    const net = createNetwork({ networkId: 'net1' });
    net.buffers.push(createBuffer({ name: '#chan' }));
    ircState.networks.push(net);
    ircState.activeBuffer.networkId = 'net1';
    ircState.activeBuffer.bufferName = '#chan';

    const now = Date.now();
    const seed: ReturnType<typeof createMessage>[] = [];
    for (let i = 0; i < 40; i++) {
      seed.push(createMessage({ text: `seed-${i}`, t: now - (40 - i) * 1000, msgid: `seed-${i}` }));
    }
    ircState.messages['net1:#chan'] = seed;
    flushSync();

    render(MessageList, { props: {} });
    flushSync();
    await new Promise((r) => requestAnimationFrame(r));
    await new Promise((r) => setTimeout(r, 80));

    const c = document.getElementById('messages') as HTMLDivElement | null;
    expect(c).not.toBeNull();
    if (!c) return;
    c.style.height = '300px';
    await new Promise((r) => requestAnimationFrame(r));
    c.scrollTop = c.scrollHeight;
    c.dispatchEvent(new Event('scroll'));
    await new Promise((r) => setTimeout(r, 30));

    c.scrollTop -= 100;
    c.dispatchEvent(new Event('scroll'));
    await new Promise((r) => setTimeout(r, 30));
    expect(c.scrollHeight - c.clientHeight - c.scrollTop).toBeGreaterThan(50);

    // Incoming action from another user, no forceScroll
    appendMessage('net1', '#chan', {
      command: 'PRIVMSG',
      nick: 'other',
      type: 'action',
      text: 'waves hello',
      t: Date.now(),
      msgid: 'incoming-action-1',
      timestamp: new Date().toISOString(),
      params: [],
      prefix: '',
    });
    flushSync();
    await new Promise((r) => requestAnimationFrame(r));
    await new Promise((r) => setTimeout(r, 100));

    const drift = c.scrollHeight - c.clientHeight - c.scrollTop;
    expect(drift).toBeLessThan(4);
  });
});
