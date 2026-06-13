import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page, userEvent } from 'vitest/browser';
import { flushSync } from 'svelte';
import InputArea from './InputArea.svelte';
import MessageList from './MessageList.svelte';
import { createNetwork, createBuffer } from '../test/factories';
import { ircState } from '../stores/ircStore.svelte';
import { clearedAtMap } from '../stores/preferences.svelte';

vi.mock('/src/stores/api', () => ({
  reconnectNetwork: vi.fn(async () => undefined),
  disconnectNetwork: vi.fn(async () => undefined),
  fetchMe: vi.fn(async () => ({ username: 'tester', email: 'tester@test.local' })),
  fetchHealth: vi.fn(async () => ({ status: 'healthy', services: {} })),
  loadHistory: vi.fn(async () => []),
  joinChannel: vi.fn(async () => undefined),
  addNetwork: vi.fn(async () => undefined),
  updateNetwork: vi.fn(async () => undefined),
  deleteNetwork: vi.fn(async () => undefined),
  archiveChannel: vi.fn(async () => undefined),
  unarchiveChannel: vi.fn(async () => undefined),
}));

function resetState(): void {
  ircState.networks.length = 0;
  ircState.activeBuffer.networkId = null;
  ircState.activeBuffer.bufferName = null;
  ircState.messages = {};
  ircState.processedMessages = {};
  ircState.backlogDivider = {};
  ircState.lastSeenMsgTime = null;
  ircState.focusLost = false;
  ircState.optimisticMessages.clear();
  Object.keys(clearedAtMap).forEach((k) => delete (clearedAtMap as Record<string, unknown>)[k]);
}

describe('Send message real-time appearance', () => {
  beforeEach(() => {
    resetState();
    vi.clearAllMocks();
  });

  it('typing in InputArea renders the optimistic message in MessageList immediately', async () => {
    const net = createNetwork({ networkId: 'net1', currentNick: 'tester' });
    net.buffers.push(createBuffer({ name: '#general' }));
    ircState.networks.push(net);
    ircState.activeBuffer.networkId = 'net1';
    ircState.activeBuffer.bufferName = '#general';
    flushSync();

    // Render the input and the message list together as the user sees them.
    render(InputArea, { props: {} });
    render(MessageList, { props: {} });

    const textarea = page.getByRole('textbox', { name: /message input/i });
    await expect.element(textarea).toBeInTheDocument();

    const uniqueText = `hello realtime ${Date.now()}`;
    await userEvent.type(textarea, uniqueText);
    await userEvent.keyboard('{Enter}');

    // The optimistic message must appear in the processed cache...
    const processed = ircState.processedMessages['net1:#general'];
    expect(processed).toHaveLength(1);
    expect(processed![0].text).toBe(uniqueText);
    expect(processed![0].nick).toBe('tester');

    // ...and MessageList must render it without waiting for a server round-trip.
    await expect.element(page.getByText(uniqueText).first()).toBeInTheDocument();
  });
});
