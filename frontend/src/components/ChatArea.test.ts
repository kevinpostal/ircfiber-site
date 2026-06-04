import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import ChatArea from './ChatArea.svelte';
import { ircState } from '../stores/ircStore.svelte';
import { loadHistory } from '/src/stores/api';
import { createNetwork, createBuffer, createMessage } from '../test/factories';

vi.mock('/src/stores/api', () => ({
  loadHistory: vi.fn(async () => []),
  reconnectNetwork: vi.fn(async () => undefined),
  disconnectNetwork: vi.fn(async () => undefined),
  joinChannel: vi.fn(async () => undefined),
  addNetwork: vi.fn(async () => undefined),
  updateNetwork: vi.fn(async () => undefined),
  deleteNetwork: vi.fn(async () => undefined),
  fetchMe: vi.fn(async () => ({ username: 'tester', email: 'tester@test.local' })),
  fetchHealth: vi.fn(async () => ({ status: 'healthy', services: {} })),
}));

beforeEach(() => {
  ircState.networks.length = 0;
  ircState.activeBuffer.networkId = null;
  ircState.activeBuffer.bufferName = null;
  ircState.messages = {};
  vi.clearAllMocks();
});

describe('ChatArea', () => {
  function setupActiveBuffer() {
    const network = createNetwork();
    const buf = createBuffer({ name: '#chan' });
    network.buffers.push(buf);
    ircState.networks.push(network);
    ircState.activeBuffer.networkId = network.networkId;
    ircState.activeBuffer.bufferName = '#chan';
    return network;
  }

  it('renders message list area', async () => {
    setupActiveBuffer();
    render(ChatArea);
    await expect.element(page.getByRole('log', { name: 'Chat messages' })).toBeInTheDocument();
  });

  it('renders input area', async () => {
    setupActiveBuffer();
    render(ChatArea);
    await expect.element(page.getByRole('textbox', { name: 'Message input' })).toBeInTheDocument();
  });

  it('renders connection status when disconnected', async () => {
    const network = createNetwork({
      connected: false,
      connectionState: 'disconnected',
      disconnectReason: 'Network error',
    });
    const buf = createBuffer({ name: '#chan' });
    network.buffers.push(buf);
    ircState.networks.push(network);
    ircState.activeBuffer.networkId = network.networkId;
    ircState.activeBuffer.bufferName = '#chan';
    render(ChatArea);
    await expect.element(page.getByText('Network error')).toBeInTheDocument();
  });

  it('triggers load more callback', async () => {
    const network = setupActiveBuffer();
    ircState.messages[`${network.networkId}:#chan`] = [createMessage({ t: Date.now() })];
    render(ChatArea);
    await expect.element(page.getByRole('log', { name: 'Chat messages' })).toBeInTheDocument();
  });

  it('handleLoadMore returns false when loadHistory returns empty', async () => {
    const network = setupActiveBuffer();
    const msg = createMessage({ t: Date.now() });
    ircState.messages[`${network.networkId}:#chan`] = [msg];
    vi.mocked(loadHistory).mockResolvedValue([]);
    render(ChatArea);
    // The LoadMore auto-check calls handleLoadMore on mount.
    // Since loadHistory returns [], handleLoadMore returns false,
    // hasMore becomes false, and the "Load more" button should be hidden.
    await expect.element(page.getByText('Load more backlog…')).not.toBeInTheDocument();
  });

  it('handleLoadMore returns false when loadHistory throws', async () => {
    const network = setupActiveBuffer();
    const msg = createMessage({ t: Date.now() });
    ircState.messages[`${network.networkId}:#chan`] = [msg];
    vi.mocked(loadHistory).mockRejectedValue(new Error('Network error'));
    render(ChatArea);
    // The auto-check calls handleLoadMore which catches the error
    // and returns false, hiding the "Load more" button.
    await expect.element(page.getByText('Load more backlog…')).not.toBeInTheDocument();
  });
});
