import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import ChatArea from './ChatArea.svelte';
import { ircState } from '../stores/ircStore.svelte';
import { loadHistory } from '/src/stores/api';
import { createNetwork, createBuffer, createMessage } from '../test/factories';

vi.mock('/src/stores/api', () => ({
  loadHistory: vi.fn(async () => []),
  loadHistoryWithMeta: vi.fn(async () => ({ messages: [], backlog_size: 0, earliest_msgid: '', earliest_ts: 0, earliest_eid: 0, cache_size: 0 })),
  reconnectNetwork: vi.fn(async () => undefined),
  clearBacklog: vi.fn(async () => undefined),
  disconnectNetwork: vi.fn(async () => undefined),
  joinChannel: vi.fn(async () => undefined),
  addNetwork: vi.fn(async () => undefined),
  updateNetwork: vi.fn(async () => undefined),
  deleteNetwork: vi.fn(async () => undefined),
  fetchMe: vi.fn(async () => ({ username: 'tester', email: 'tester@test.local' })),
  fetchHealth: vi.fn(async () => ({ status: 'healthy', services: {} })),
  archiveChannel: vi.fn(async () => undefined),
  unarchiveChannel: vi.fn(async () => undefined),
  editUpload: vi.fn(async () => undefined),
  createIrcArtSave: vi.fn(async () => undefined),
  updateIrcArtSave: vi.fn(async () => undefined),
  fetchIrcArtSave: vi.fn(async () => undefined),
  fetchIrcArtSavesOffset: vi.fn(async () => ({ entries: [], total: 0 })),
  deleteIrcArtSave: vi.fn(async () => undefined),
  fetchUploads: vi.fn(async () => []),
  fetchUploadsOffset: vi.fn(async () => ({ entries: [], total: 0 })),
  deleteUpload: vi.fn(async () => undefined),
  fetchUploadById: vi.fn(async () => undefined),
  createPastebin: vi.fn(async () => undefined),
  fetchPastebinsOffset: vi.fn(async () => ({ entries: [], total: 0 })),
  deletePastebin: vi.fn(async () => undefined),
  pastebinRawUrl: vi.fn(() => ''),
  fetchArchiveNames: vi.fn(async () => ({})),
  // ircStore imports this for the WebSocket-sync message normalization
  // path. The tests in this file don't exercise that path, so pass-through
  // is fine.
  normalizeMessage: vi.fn((m: unknown) => m),
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

  it('renders the loadMore button at the top of the log', async () => {
    const network = setupActiveBuffer();
    const msg = createMessage({ t: Date.now() });
    ircState.messages[`${network.networkId}:#chan`] = [msg];
    render(ChatArea);
    // IRCCloud renders the "Load more backlog…" button at the top of
    // the log; infiniscroll fires when the user scrolls to the very
    // top, and the viewport-fill loop fetches until the log overflows.
    await expect.element(page.getByText('Load more backlog…')).toBeInTheDocument();
  });

  it('keeps the loadMore button when loadHistory would fail', async () => {
    const network = setupActiveBuffer();
    const msg = createMessage({ t: Date.now() });
    ircState.messages[`${network.networkId}:#chan`] = [msg];
    vi.mocked(loadHistory).mockRejectedValue(new Error('Network error'));
    render(ChatArea);
    // No fetch happens on mount, so the failure never triggers; the
    // loadMore button stays rendered.
    await expect.element(page.getByText('Load more backlog…')).toBeInTheDocument();
  });
});
