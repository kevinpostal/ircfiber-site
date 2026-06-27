import { describe, expect, it, beforeEach } from 'vitest';
import { render } from 'vitest-browser-svelte';
import ServerLogTimeline from './ServerLogTimeline.svelte';
import { ircState } from '../stores/ircStore.svelte';
import { clearedAtMap } from '../stores/preferences.svelte';
import { createNetwork, createBuffer, createMessage } from '../test/factories';

beforeEach(() => {
  ircState.networks.length = 0;
  ircState.activeBuffer.networkId = null;
  ircState.activeBuffer.bufferName = null;
  Object.keys(clearedAtMap).forEach((k) => delete (clearedAtMap as Record<string, unknown>)[k]);
});

function setupServerBuffer(opts: { connected?: boolean } = {}): void {
  const network = createNetwork({
    networkId: 'net1',
    name: 'SuperNets',
    connected: opts.connected ?? true,
    connectionState: opts.connected === false ? 'disconnected' : 'connected',
  });
  const buf = createBuffer({ name: '_server' });
  network.buffers.push(buf);
  ircState.networks.push(network);
  ircState.activeBuffer.networkId = 'net1';
  ircState.activeBuffer.bufferName = '_server';
}

describe('ServerLogTimeline', () => {
  it('renders connection-attempt cards from messages', async () => {
    setupServerBuffer();
    const network = ircState.networks[0];

    // phase events give groupServerLog a clear start/end for one attempt.
    const messages = [
      createMessage({ phase: 'connecting', text: 'connecting', t: 1000, eid: 1 }),
      createMessage({ phase: 'welcome', text: 'welcome', t: 1100, eid: 2 }),
    ];
    render(ServerLogTimeline, { props: { messages, network } });
    expect(document.querySelectorAll('.serverLogCard').length).toBeGreaterThan(0);
  });

  it('hides cards when clearedAt is set after every message', async () => {
    // Disconnected network so the synthetic "Network is connected" card
    // doesn't fill in for the filtered-out real cards.
    setupServerBuffer({ connected: false });
    const network = ircState.networks[0];

    const messages = [
      createMessage({ phase: 'connecting', text: 'connecting', t: 1000, eid: 1 }),
      createMessage({ phase: 'welcome', text: 'welcome', t: 1100, eid: 2 }),
    ];
    // Future timestamp = filter out every message above, so attempts -> 0
    clearedAtMap['net1:_server'] = Date.now() + 60_000;
    render(ServerLogTimeline, { props: { messages, network } });
    expect(document.querySelectorAll('.serverLogCard').length).toBe(0);
  });

  it('shows cards again when clearedAt is removed', async () => {
    setupServerBuffer({ connected: false });
    const network = ircState.networks[0];

    const messages = [
      createMessage({ phase: 'connecting', text: 'connecting', t: 1000, eid: 1 }),
      createMessage({ phase: 'welcome', text: 'welcome', t: 1100, eid: 2 }),
    ];
    clearedAtMap['net1:_server'] = Date.now() + 60_000;
    const { rerender } = render(ServerLogTimeline, { props: { messages, network } });
    expect(document.querySelectorAll('.serverLogCard').length).toBe(0);

    delete clearedAtMap['net1:_server'];
    await rerender({ messages, network });
    expect(document.querySelectorAll('.serverLogCard').length).toBeGreaterThan(0);
  });
});