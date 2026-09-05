// Regression: a DM with a mixed-case nick never rendered.
//
// Every store write keys through `normalizeChannelName`, which folds bare
// nicks to lower case, while `ircState.activeBuffer.bufferName` deliberately
// keeps the counterparty's display case (`EliManning`) so the header and the
// sidebar read correctly. MessageList built its store key from the raw
// buffer name, so `ircState.messages['<net>:EliManning']` was undefined
// forever: `hasHistoryLoaded` stayed false, the log sat on the
// "Loading history…" spinner, and the messages were in the store the whole
// time. Any nick that is not already lower-case was affected; channels were
// fine because they are normalized before they reach activeBuffer.
import { describe, expect, it, beforeEach } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { flushSync } from 'svelte';
import MessageList from './MessageList.svelte';
import { createNetwork, createBuffer, createMessage } from '../test/factories';
import { ircState, setMessages } from '../stores/ircStore.svelte';

function resetState(): void {
  ircState.networks.length = 0;
  ircState.activeBuffer.networkId = null;
  ircState.activeBuffer.bufferName = null;
  ircState.messages = {};
  ircState.processedMessages = {};
  document.body.innerHTML = '';
}

beforeEach(resetState);

/** A network with one DM buffer whose nick has mixed case. */
function seed(nick: string) {
  const net = createNetwork({ networkId: 'net1', name: 'Supernets', currentNick: 'Zodifag' });
  net.buffers.push(createBuffer({ name: nick, type: 'query' }));
  ircState.networks.push(net);
  // The store folds the key; the active buffer keeps display case.
  setMessages('net1', nick, [
    createMessage({ nick, text: 'hey it is Eli, first DM', t: Date.now() - 2000 }),
    createMessage({ nick, text: 'second DM line', t: Date.now() - 1000 }),
  ]);
  ircState.activeBuffer.networkId = 'net1';
  ircState.activeBuffer.bufferName = nick;
  flushSync();
}

const log = () => document.getElementById('messages') as HTMLElement;
const rows = () => [...log().querySelectorAll('.row.messageRow')].map((r) => (r.textContent || '').replace(/\s+/g, ' ').trim());

describe('DM buffers with mixed-case nicks', () => {
  it('renders the conversation instead of spinning on "Loading history…"', async () => {
    seed('EliManning');
    render(MessageList, { props: {} });
    flushSync();

    expect(log().textContent).not.toContain('Loading history…');
    expect(rows().join(' | ')).toContain('hey it is Eli, first DM');
    expect(rows().join(' | ')).toContain('second DM line');
  });

  it('still renders an all-lower-case nick (the case that always worked)', async () => {
    seed('plainnick');
    render(MessageList, { props: {} });
    flushSync();

    expect(log().textContent).not.toContain('Loading history…');
    expect(rows().join(' | ')).toContain('second DM line');
  });

  it('shows the empty state, not the spinner, for a DM with no history', async () => {
    const net = createNetwork({ networkId: 'net1', name: 'Supernets', currentNick: 'Zodifag' });
    net.buffers.push(createBuffer({ name: 'EliManning', type: 'query' }));
    ircState.networks.push(net);
    // A completed fetch writes an empty array — that is what flips
    // hasHistoryLoaded, and it is keyed folded too.
    setMessages('net1', 'EliManning', []);
    ircState.activeBuffer.networkId = 'net1';
    ircState.activeBuffer.bufferName = 'EliManning';
    flushSync();

    render(MessageList, { props: {} });
    flushSync();

    expect(log().textContent).not.toContain('Loading history…');
    expect(log().textContent).toContain('No messages with EliManning yet');
  });

  it('keeps spinning only while the fetch is genuinely outstanding', async () => {
    const net = createNetwork({ networkId: 'net1', name: 'Supernets', currentNick: 'Zodifag' });
    net.buffers.push(createBuffer({ name: 'EliManning', type: 'query' }));
    ircState.networks.push(net);
    ircState.activeBuffer.networkId = 'net1';
    ircState.activeBuffer.bufferName = 'EliManning';
    flushSync();

    render(MessageList, { props: {} });
    flushSync();
    expect(log().textContent).toContain('Loading history…');

    // …and stops as soon as the folded key appears.
    setMessages('net1', 'EliManning', [createMessage({ nick: 'EliManning', text: 'late arrival' })]);
    flushSync();
    expect(log().textContent).not.toContain('Loading history…');
    expect(rows().join(' | ')).toContain('late arrival');
  });
});
