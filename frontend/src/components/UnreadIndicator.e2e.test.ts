import { describe, it, expect, beforeEach, vi } from 'vitest';
import { flushSync } from 'svelte';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import Sidebar from './Sidebar.svelte';
import { createNetwork, createBuffer, createMessage } from '../test/factories';
import { ircState, setActiveBuffer, appendMessage, batchAppendMessages } from '../stores/ircStore.svelte';
import { collapsedMap, lastSeenMap, bottomSeenMap, unreadMap, highlightMap } from '../stores/preferences.svelte';

function setupNet(netId = 'net1', chan = '#general') {
  const net = createNetwork({ networkId: netId, name: 'TestNet', nick: 'me', currentNick: 'me' });
  net.buffers.push(createBuffer({ name: chan, unreadCount: 0, highlightCount: 0, highlight: false }));
  ircState.networks.push(net);
  return net;
}

describe('Unread indicator — full e2e suite', () => {
  beforeEach(() => {
    ircState.networks = [];
    ircState.activeBuffer.networkId = 'net1';
    ircState.activeBuffer.bufferName = '#other';
    ircState.messages = {};
    ircState.processedMessages = {};
    ircState.focusLost = false;
    ircState.pulseBuffers.clear();
    for (const k of Object.keys(collapsedMap)) delete collapsedMap[k];
    for (const k of Object.keys(lastSeenMap)) delete lastSeenMap[k];
    for (const k of Object.keys(bottomSeenMap)) delete bottomSeenMap[k];
    for (const k of Object.keys(unreadMap)) delete (unreadMap as Record<string, unknown>)[k];
    for (const k of Object.keys(highlightMap)) delete (highlightMap as Record<string, unknown>)[k];
    localStorage.clear();
  });

  it('shows badge 1 after single unread message in inactive buffer', async () => {
    setupNet();
    render(Sidebar, { props: { onSwitchBuffer: vi.fn(), onAddNetwork: vi.fn(), onNetworkOptions: vi.fn() } });
    expect(document.querySelector('.buffer-unread')).toBeNull();
    appendMessage('net1', '#general', createMessage({ text: 'hello', nick: 'alice', command: 'PRIVMSG' }));
    flushSync();
    const badge = document.querySelector('.network-buffers .buffer-unread');
    expect(badge?.textContent?.trim()).toBe('1');
    expect(document.querySelector('.buffer-item.unread')).toBeTruthy();
  });

  it('number changes dynamically 1→2→5→10', async () => {
    setupNet();
    render(Sidebar, { props: { onSwitchBuffer: vi.fn(), onAddNetwork: vi.fn(), onNetworkOptions: vi.fn() } });
    appendMessage('net1', '#general', createMessage({ text: 'm1', nick: 'a' }));
    flushSync();
    expect(document.querySelector('.buffer-unread')?.textContent?.trim()).toBe('1');
    appendMessage('net1', '#general', createMessage({ text: 'm2', nick: 'a' }));
    flushSync();
    expect(document.querySelector('.buffer-unread')?.textContent?.trim()).toBe('2');
    for (let i = 0; i < 3; i++) {
      appendMessage('net1', '#general', createMessage({ text: `m${i + 3}`, nick: 'a' }));
    }
    flushSync();
    expect(document.querySelector('.buffer-unread')?.textContent?.trim()).toBe('5');
    for (let i = 0; i < 5; i++) {
      appendMessage('net1', '#general', createMessage({ text: `x${i}`, nick: 'a' }));
    }
    flushSync();
    expect(document.querySelector('.buffer-unread')?.textContent?.trim()).toBe('10');
  });

  it('batchAppendMessages increments correctly to N (per-batch atomic)', async () => {
    setupNet();
    render(Sidebar, { props: { onSwitchBuffer: vi.fn(), onAddNetwork: vi.fn(), onNetworkOptions: vi.fn() } });
    batchAppendMessages('net1', '#general', [
      createMessage({ text: 'b1', nick: 'alice' }),
      createMessage({ text: 'b2', nick: 'bob' }),
      createMessage({ text: 'b3', nick: 'carol' }),
    ]);
    flushSync();
    expect(document.querySelector('.buffer-unread')?.textContent?.trim()).toBe('3');
    batchAppendMessages('net1', '#general', [
      createMessage({ text: 'b4', nick: 'alice' }),
      createMessage({ text: 'b5', nick: 'bob' }),
    ]);
    flushSync();
    expect(document.querySelector('.buffer-unread')?.textContent?.trim()).toBe('5');
  });

  it('batch highlight count increments per highlight', async () => {
    const net = createNetwork({ networkId: 'net1', name: 'TestNet', nick: 'me', currentNick: 'me' });
    net.buffers.push(createBuffer({ name: '#general', unreadCount: 0, highlight: false, highlightCount: 0 }));
    ircState.networks.push(net);
    render(Sidebar, { props: { onSwitchBuffer: vi.fn(), onAddNetwork: vi.fn(), onNetworkOptions: vi.fn() } });
    // 2 of 3 messages mention me → 2 highlights
    batchAppendMessages('net1', '#general', [
      createMessage({ text: 'hey me look', nick: 'alice' }),
      createMessage({ text: 'hello world', nick: 'bob' }),
      createMessage({ text: 'me again', nick: 'carol' }),
    ]);
    flushSync();
    const buf = ircState.networks[0].buffers.find(b => b.name === '#general')!;
    expect(buf.unreadCount).toBe(3);
    expect(buf.highlightCount).toBe(2);
    expect(buf.highlight).toBe(true);
  });

  it('per-channel counts are independent', async () => {
    const net = createNetwork({ networkId: 'net1', name: 'TestNet', nick: 'me', currentNick: 'me' });
    net.buffers.push(createBuffer({ name: '#a', unreadCount: 0 }));
    net.buffers.push(createBuffer({ name: '#b', unreadCount: 0 }));
    net.buffers.push(createBuffer({ name: '#c', unreadCount: 0 }));
    ircState.networks.push(net);
    render(Sidebar, { props: { onSwitchBuffer: vi.fn(), onAddNetwork: vi.fn(), onNetworkOptions: vi.fn() } });
    appendMessage('net1', '#a', createMessage({ text: '1' }));
    appendMessage('net1', '#a', createMessage({ text: '2' }));
    appendMessage('net1', '#b', createMessage({ text: '1' }));
    appendMessage('net1', '#c', createMessage({ text: '1' }));
    appendMessage('net1', '#c', createMessage({ text: '2' }));
    appendMessage('net1', '#c', createMessage({ text: '3' }));
    flushSync();
    const badges = [...document.querySelectorAll('.network-buffers .buffer-unread')].map(b => b.textContent?.trim()).sort();
    expect(badges).toEqual(['1', '2', '3']);
  });

  it('switching to buffer clears its badge', async () => {
    setupNet();
    render(Sidebar, { props: { onSwitchBuffer: vi.fn(), onAddNetwork: vi.fn(), onNetworkOptions: vi.fn() } });
    appendMessage('net1', '#general', createMessage({ text: 'hello' }));
    appendMessage('net1', '#general', createMessage({ text: 'again' }));
    flushSync();
    expect(document.querySelector('.buffer-unread')?.textContent?.trim()).toBe('2');
    setActiveBuffer('net1', '#general');
    flushSync();
    expect(document.querySelector('.buffer-unread')).toBeNull();
    expect(document.querySelector('.buffer-item.unread')).toBeNull();
    // new message after switching away again should recount from 0
    setActiveBuffer('net1', '#other');
    flushSync();
    appendMessage('net1', '#general', createMessage({ text: 'new' }));
    flushSync();
    expect(document.querySelector('.buffer-unread')?.textContent?.trim()).toBe('1');
  });

  it('collapsed network header shows total unread', async () => {
    const net = createNetwork({ networkId: 'net1', name: 'TestNet' });
    net.buffers.push(createBuffer({ name: '#a', unreadCount: 0 }));
    net.buffers.push(createBuffer({ name: '#b', unreadCount: 0 }));
    ircState.networks.push(net);
    collapsedMap['net1'] = true;
    render(Sidebar, { props: { onSwitchBuffer: vi.fn(), onAddNetwork: vi.fn(), onNetworkOptions: vi.fn() } });
    appendMessage('net1', '#a', createMessage({ text: '1' }));
    appendMessage('net1', '#b', createMessage({ text: '1' }));
    appendMessage('net1', '#b', createMessage({ text: '2' }));
    flushSync();
    // channels hidden, header badge should show 3
    expect(document.querySelector('.network-buffers')).toBeNull();
    const headerBadge = document.querySelector('[data-testid="network-unread"]');
    expect(headerBadge?.textContent?.trim()).toBe('3');
  });

  it('no badge when active buffer receives message with focus', async () => {
    setupNet();
    ircState.activeBuffer.bufferName = '#general';
    render(Sidebar, { props: { onSwitchBuffer: vi.fn(), onAddNetwork: vi.fn(), onNetworkOptions: vi.fn() } });
    appendMessage('net1', '#general', createMessage({ text: 'hello' }));
    flushSync();
    expect(document.querySelector('.buffer-unread')).toBeNull();
    expect(document.querySelector('.buffer-item.unread')).toBeNull();
  });

  it('incremental count after clear and batch mix', async () => {
    setupNet();
    render(Sidebar, { props: { onSwitchBuffer: vi.fn(), onAddNetwork: vi.fn(), onNetworkOptions: vi.fn() } });
    batchAppendMessages('net1', '#general', [
      createMessage({ text: 'a' }), createMessage({ text: 'b' }), createMessage({ text: 'c' }),
    ]);
    flushSync();
    expect(document.querySelector('.buffer-unread')?.textContent?.trim()).toBe('3');
    appendMessage('net1', '#general', createMessage({ text: 'd' }));
    flushSync();
    expect(document.querySelector('.buffer-unread')?.textContent?.trim()).toBe('4');
    batchAppendMessages('net1', '#general', [createMessage({ text: 'e' }), createMessage({ text: 'f' })]);
    flushSync();
    expect(document.querySelector('.buffer-unread')?.textContent?.trim()).toBe('6');
  });
});
