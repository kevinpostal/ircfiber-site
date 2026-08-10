import { describe, it, expect, beforeEach } from 'vitest';
import { flushSync } from 'svelte';
import { page } from 'vitest/browser';
import MessageList from './MessageList.svelte';
import { createMessage, createNetwork, createBuffer } from '../test/factories';
import { ircState } from '../stores/ircStore.svelte';
import type { IRCMessage } from '../types';
import { render } from 'vitest-browser-svelte';

describe('MessageList — refresh lands at bottom', () => {
  beforeEach(() => {
    ircState.networks.length = 0;
    for (const k of Object.keys(ircState.messages)) delete ircState.messages[k];
    for (const k of Object.keys(ircState.processedMessages)) delete ircState.processedMessages[k];
    for (const k of Object.keys(ircState.backlogDivider)) delete ircState.backlogDivider[k];
    ircState.activeBuffer.networkId = null;
    ircState.activeBuffer.bufferName = null;
  });

  it('initial buffer open with 200 messages lands at the very bottom', async () => {
    const net = createNetwork({ networkId: 'net1' });
    net.buffers.push(createBuffer({ name: '#chan' }));
    ircState.networks.push(net);
    ircState.activeBuffer.networkId = 'net1';
    ircState.activeBuffer.bufferName = '#chan';

    const now = Date.now();
    const messages: IRCMessage[] = [];
    for (let i = 0; i < 200; i++) {
      messages.push(createMessage({ text: `msg-${i + 1}`, t: now - (200 - i) * 1000, msgid: `m-${i + 1}` }));
    }
    ircState.messages['net1:#chan'] = messages;
    flushSync();

    render(MessageList, { props: {} });
    const container = document.getElementById('messages') as HTMLDivElement;
    expect(container).not.toBeNull();
    container.style.height = '300px';
    // Force layout
    container.getBoundingClientRect();
    await new Promise((r) => requestAnimationFrame(r));
    await new Promise((r) => setTimeout(r, 250));

    const distFromBottom = container.scrollHeight - container.clientHeight - container.scrollTop;
    expect(distFromBottom).toBeLessThan(5);
  });

  it('refresh with flex height 0 at mount still lands at bottom after layout', async () => {
    const net = createNetwork({ networkId: 'net1' });
    net.buffers.push(createBuffer({ name: '#chan' }));
    ircState.networks.push(net);
    ircState.activeBuffer.networkId = 'net1';
    ircState.activeBuffer.bufferName = '#chan';

    const now = Date.now();
    const messages: IRCMessage[] = [];
    for (let i = 0; i < 250; i++) {
      messages.push(createMessage({ text: `refresh-msg-${i + 1}`, t: now - (250 - i) * 1000, msgid: `rm-${i + 1}` }));
    }
    ircState.messages['net1:#chan'] = messages;
    flushSync();

    render(MessageList, { props: {} });
    const container = document.getElementById('messages') as HTMLDivElement;
    expect(container).not.toBeNull();
    // Simulate the isBootLoading → ChatArea transition where the flex
    // container hasn't been sized yet (clientHeight 0) at the moment the
    // snap runs. Before the fix, the synchronous snap landed at 0 and the
    // user was stranded mid-history.
    container.style.height = '0px';
    container.getBoundingClientRect();
    await new Promise((r) => requestAnimationFrame(r));
    // Now layout settles to real height (like after isBootLoading flips)
    container.style.height = '300px';
    container.getBoundingClientRect();
    // Trigger a resize observation via dispatch (the component's
    // ResizeObserver and pinnedResnap chain should correct)
    await new Promise((r) => requestAnimationFrame(r));
    await new Promise((r) => setTimeout(r, 400));

    const distFromBottom = container.scrollHeight - container.clientHeight - container.scrollTop;
    expect(distFromBottom).toBeLessThan(5);
  });

  it('async history arrival after mount lands at bottom (sync race)', async () => {
    const net = createNetwork({ networkId: 'net1' });
    net.buffers.push(createBuffer({ name: '#chan' }));
    ircState.networks.push(net);
    ircState.activeBuffer.networkId = 'net1';
    ircState.activeBuffer.bufferName = '#chan';

    // Mount with empty history (like before sync)
    ircState.messages['net1:#chan'] = [];
    flushSync();
    render(MessageList, { props: {} });
    const container = document.getElementById('messages') as HTMLDivElement;
    container.style.height = '300px';
    await new Promise((r) => requestAnimationFrame(r));

    // Sync arrives with 200 messages after mount
    const now = Date.now();
    const messages: IRCMessage[] = [];
    for (let i = 0; i < 200; i++) {
      messages.push(createMessage({ text: `late-${i + 1}`, t: now - (200 - i) * 1000, msgid: `late-${i + 1}` }));
    }
    ircState.messages['net1:#chan'] = messages;
    flushSync();
    await new Promise((r) => requestAnimationFrame(r));
    await new Promise((r) => setTimeout(r, 300));

    const distFromBottom = container.scrollHeight - container.clientHeight - container.scrollTop;
    expect(distFromBottom).toBeLessThan(5);
  });
});
