import { describe, expect, it, beforeEach } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { flushSync } from 'svelte';
import MessageList from './MessageList.svelte';
import { createMessage, createNetwork, createBuffer } from '../test/factories';
import { ircState } from '../stores/ircStore.svelte';

beforeEach(() => {
  ircState.networks.length = 0;
  ircState.messages = {};
  ircState.processedMessages = {};
});

describe('probe2', () => {
  it('debug scroll never strands', async () => {
    const net = createNetwork({ networkId: 'net1' });
    net.buffers.push(createBuffer({ name: '#chan' }));
    ircState.networks.push(net);
    ircState.activeBuffer.networkId = 'net1';
    ircState.activeBuffer.bufferName = '#chan';
    const now = Date.now();
    const seed = [];
    for (let i = 0; i < 250; i++) {
      seed.push(createMessage({ command: 'PRIVMSG', nick: 'alice', text: 'm' + i, t: now - (250 - i) * 1000, msgid: 's' + i }));
    }
    ircState.messages['net1:#chan'] = seed;
    flushSync();
    render(MessageList, { props: {} });
    flushSync();
    await new Promise(r => requestAnimationFrame(r));
    await new Promise(r => setTimeout(r, 30));
    const c = document.getElementById('messages') as HTMLDivElement;
    for (let reveal = 0; reveal < 2; reveal++) {
      console.log('iter', reveal, 'before scrollTop:', c.scrollTop, 'children:', c.children.length, 'scrollHeight:', c.scrollHeight);
      c.scrollTop = 0;
      c.dispatchEvent(new Event('scroll'));
      console.log('  after scrollTop=0:', c.scrollTop);
      await new Promise(r => setTimeout(r, 100));
      console.log('  after 100ms wait:', c.scrollTop);
      await new Promise(r => setTimeout(r, 250));
      console.log('  after 250ms wait:', c.scrollTop);
    }
  });
});
