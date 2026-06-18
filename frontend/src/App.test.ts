import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page, userEvent } from 'vitest/browser';
import { flushSync } from 'svelte';
import App from './App.svelte';
import { ircState, updateChannelUsers } from './stores/ircStore.svelte';
import { createNetwork, createBuffer, createMessage, createMember } from './test/factories';

vi.mock('/src/stores/wsConnection.svelte.ts', () => ({
  // The real connectWebSocket opens a WebSocket and fires onopen/onmessage
  // asynchronously. Tests need the boot sequence to complete synchronously
  // so isBootLoading (which gates the sidebar/chat behind
  // syncReceived && backlogReady) flips to false right after render().
  // Simulate the minimal boot: open → stat_user → boot sync. The sync
  // message is what sets syncReceived=true and backlogReady=true in App.
  connectWebSocket: vi.fn((onMessage, onOpen) => {
    onOpen?.();
    onMessage?.({ type: 'stat_user', username: 'tester', email: 'tester@test.local' });
    onMessage?.({ type: 'sync', networks: [] });
  }),
  disconnectWebSocket: vi.fn(),
  sendRaw: vi.fn(),
  sendMessage: vi.fn(),
  requestSync: vi.fn(),
  requestSwitchBuffer: vi.fn(),
  wsState: { value: 'disconnected' },
  maxEidTracker: { value: 0 },
  setMaxEid: vi.fn(),
}));

vi.mock('/src/stores/api', () => ({
  fetchMe: vi.fn(async () => ({ username: 'tester', email: 'tester@test.local' })),
  fetchHealth: vi.fn(async () => ({ status: 'healthy', services: {} })),
  loadHistory: vi.fn(async () => []),
  loadHistoryWithMeta: vi.fn(async () => ({ messages: [], backlog_size: 0, earliest_msgid: '', earliest_ts: 0, earliest_eid: 0, cache_size: 0 })),
  reconnectNetwork: vi.fn(async () => undefined),
  disconnectNetwork: vi.fn(async () => undefined),
  joinChannel: vi.fn(async () => undefined),
  addNetwork: vi.fn(async () => undefined),
  updateNetwork: vi.fn(async () => undefined),
  deleteNetwork: vi.fn(async () => undefined),
  pinChannel: vi.fn(async () => undefined),
  unpinChannel: vi.fn(async () => undefined),
  archiveChannel: vi.fn(async () => undefined),
  unarchiveChannel: vi.fn(async () => undefined),
  deletePastebin: vi.fn(async () => undefined),
  fetchPastebinsOffset: vi.fn(async () => ({ entries: [], total: 0 })),
  updatePastebin: vi.fn(async () => undefined),
  pastebinRawUrl: vi.fn((id: string) => `/pastebin/${id}/raw`),
  updateMembersCollapsed: vi.fn(async () => undefined),
  changePassword: vi.fn(async () => undefined),
  deleteAccount: vi.fn(async () => undefined),
  uploadAvatar: vi.fn(async () => undefined),
  removeAvatar: vi.fn(async () => undefined),
  deleteUpload: vi.fn(async () => undefined),
  fetchUploadsOffset: vi.fn(async () => ({ uploads: [], total: 0 })),
  updateCollapsed: vi.fn(async () => undefined),
  updateInactiveCollapsed: vi.fn(async () => undefined),
  updateNetworkOrder: vi.fn(async () => undefined),
  hideChannel: vi.fn(async () => undefined),
  unhideChannel: vi.fn(async () => undefined),
}));

import { connectWebSocket, disconnectWebSocket, sendRaw, sendMessage, requestSync, requestSwitchBuffer } from '/src/stores/wsConnection.svelte.ts';
import { fetchMe, fetchHealth, loadHistory, reconnectNetwork, disconnectNetwork, joinChannel, addNetwork, updateNetwork, deleteNetwork } from '/src/stores/api';

beforeEach(() => {
  ircState.networks.length = 0;
  ircState.activeBuffer.networkId = null;
  ircState.activeBuffer.bufferName = null;
  ircState.messages = {};
  ircState.overlay = { type: null, data: null };
  ircState.contextMenu = { visible: false, x: 0, y: 0, actions: [] };
  ircState.showSettings = false;
  ircState.showShortcuts = false;
  history.replaceState({}, '', '/');
  vi.clearAllMocks();
});

describe('App', () => {
  it('renders the app layout', async () => {
    render(App);
    expect(document.querySelector('#wrap')).toBeInTheDocument();
  });

  it('renders sidebar with networks', async () => {
    const net = createNetwork({ name: 'Libera' });
    net.buffers.push(createBuffer({ name: '#general' }));
    ircState.networks.push(net);
    flushSync();

    render(App);
    await expect.element(page.getByText('Libera').first()).toBeInTheDocument();
    await expect.element(page.getByText('general').first()).toBeInTheDocument();
  });

  it('renders chat area', async () => {
    const net = createNetwork();
    const buf = createBuffer({ name: '#chan' });
    net.buffers.push(buf);
    ircState.networks.push(net);
    ircState.activeBuffer.networkId = net.networkId;
    ircState.activeBuffer.bufferName = '#chan';
    flushSync();

    render(App);
    await expect.element(page.getByRole('log', { name: 'Chat messages' })).toBeInTheDocument();
  });

  it('renders buffer header', async () => {
    const net = createNetwork({ networkId: 'net1' });
    net.buffers.push(createBuffer({ name: '#general' }));
    ircState.networks.push(net);
    ircState.activeBuffer.networkId = 'net1';
    ircState.activeBuffer.bufferName = '#general';
    flushSync();

    render(App);
    await expect.element(page.getByRole('heading', { name: '#general' })).toBeInTheDocument();
  });

  it('buffer switching updates downstream components', async () => {
    const net1 = createNetwork({ networkId: 'net1', name: 'TestNet' });
    net1.buffers.push(createBuffer({ name: '#chan1' }));
    net1.buffers.push(createBuffer({ name: '#chan2' }));
    ircState.networks.push(net1);
    ircState.activeBuffer.networkId = 'net1';
    ircState.activeBuffer.bufferName = '#chan1';
    flushSync();

    render(App);
    await expect.element(page.getByRole('heading', { name: '#chan1' })).toBeInTheDocument();

    ircState.activeBuffer.networkId = 'net1';
    ircState.activeBuffer.bufferName = '#chan2';
    flushSync();

    await expect.element(page.getByRole('heading', { name: '#chan2' })).toBeInTheDocument();
  });

  it('message isolation between networks', async () => {
    const net1 = createNetwork({ networkId: 'net1', name: 'Net1' });
    net1.buffers.push(createBuffer({ name: '#general' }));
    const net2 = createNetwork({ networkId: 'net2', name: 'Net2' });
    net2.buffers.push(createBuffer({ name: '#general' }));
    ircState.networks.push(net1, net2);
    ircState.activeBuffer.networkId = 'net1';
    ircState.activeBuffer.bufferName = '#general';
    ircState.messages['net1:#general'] = [createMessage({ text: 'hello from net1', t: Date.now() })];
    ircState.messages['net2:#general'] = [createMessage({ text: 'hello from net2', t: Date.now() })];
    flushSync();

    render(App);

    await expect.element(page.getByText('hello from net1')).toBeInTheDocument();
    const net2Msg = page.getByText('hello from net2');
    await expect(net2Msg).not.toBeInTheDocument();
  });

  it('opens join modal from server log menu gear → Join a channel…', async () => {
    const network = createNetwork({ networkId: 'net1', name: 'SuperNETs', host: 'irc.supernets.org', port: 6697 });
    const buf = createBuffer({ name: '_server' });
    network.buffers.push(buf);
    ircState.networks.push(network);
    flushSync();

    render(App);

    const gear = document.querySelector('.network-header .bufferOptions') as HTMLButtonElement;
    expect(gear).toBeTruthy();
    await userEvent.click(gear);

    // ServerLogContextMenu opens — scope to the menu to avoid the sidebar button
    const joinButton = document.querySelector('#serverLogContextMenu button.contextMenu__item.join') as HTMLButtonElement;
    expect(joinButton).toBeTruthy();

    // Clicking Join a channel… opens the JoinModal
    await userEvent.click(joinButton);

    await expect.element(page.getByText('Which channel do you want to join?')).toBeInTheDocument();
    await expect.element(page.getByText('SuperNETs (irc.supernets.org:6697)')).toBeInTheDocument();
  });

  it('opens edit network modal from server log menu gear → Edit…', async () => {
    const network = createNetwork({ networkId: 'net1', name: 'Libera' });
    const buf = createBuffer({ name: '_server' });
    network.buffers.push(buf);
    ircState.networks.push(network);
    flushSync();

    render(App);

    const gear = document.querySelector('.network-header .bufferOptions') as HTMLButtonElement;
    await userEvent.click(gear);

    await expect.element(page.getByRole('button', { name: 'Edit…' })).toBeInTheDocument();
    await userEvent.click(page.getByRole('button', { name: 'Edit…' }));

    // NetworkForm is now showing in edit mode
    await expect.element(page.getByText('Edit network')).toBeInTheDocument();
  });

  it('member panel state updates in real-time when another tab toggles it via storage event', async () => {
    // Setup: connect to a channel so the member panel is rendered
    const net = createNetwork({ networkId: 'net1' });
    net.buffers.push(createBuffer({ name: '#chan', type: 'channel' }));
    ircState.networks.push(net);
    ircState.activeBuffer.networkId = 'net1';
    ircState.activeBuffer.bufferName = '#chan';
    flushSync();

    render(App);

    // Initially the member panel is open (no entry in membersCollapsedMap)
    expect(document.querySelector('#wrap')?.classList.contains('members-collapsed')).toBe(false);

    // Simulate another tab closing the member panel by writing to
    // membersCollapsedMap via the storage event
    const event = new StorageEvent('storage', {
      key: 'ircfiber:membersCollapsed',
      newValue: JSON.stringify({ 'net1:#chan': true }),
    });
    window.dispatchEvent(event);
    flushSync();

    // Tab B's wrap should now have the members-collapsed class, even though
    // the user never interacted with the panel in this tab
    expect(document.querySelector('#wrap')?.classList.contains('members-collapsed')).toBe(true);

    // Simulate the other tab re-opening the member panel
    const event2 = new StorageEvent('storage', {
      key: 'ircfiber:membersCollapsed',
      newValue: JSON.stringify({}),
    });
    window.dispatchEvent(event2);
    flushSync();

    expect(document.querySelector('#wrap')?.classList.contains('members-collapsed')).toBe(false);
  });

  describe('member list visibility on join/leave', () => {
    it('shows member list when channel is joined', async () => {
      const net = createNetwork({ networkId: 'net1' });
      net.buffers.push(createBuffer({ name: '#general', isJoined: true, users: [createMember({ nick: 'alice' })] }));
      ircState.networks.push(net);
      ircState.activeBuffer.networkId = 'net1';
      ircState.activeBuffer.bufferName = '#general';
      flushSync();

      render(App);
      expect(document.querySelector('#member-sidebar')).toBeInTheDocument();
      expect(document.querySelector('#wrap')?.classList.contains('has-members')).toBe(true);
    });

    it('hides member list when channel is parted', async () => {
      const net = createNetwork({ networkId: 'net1' });
      net.buffers.push(createBuffer({ name: '#general', isJoined: false }));
      ircState.networks.push(net);
      ircState.activeBuffer.networkId = 'net1';
      ircState.activeBuffer.bufferName = '#general';
      flushSync();

      render(App);
      expect(document.querySelector('#member-sidebar')).not.toBeInTheDocument();
      expect(document.querySelector('#wrap')?.classList.contains('has-members')).toBe(false);
    });

    it('hides member list after PART event', async () => {
      const net = createNetwork({ networkId: 'net1', currentNick: 'me' });
      net.buffers.push(createBuffer({ name: '#general', isJoined: true, users: [createMember({ nick: 'me' })] }));
      ircState.networks.push(net);
      ircState.activeBuffer.networkId = 'net1';
      ircState.activeBuffer.bufferName = '#general';
      flushSync();

      render(App);
      expect(document.querySelector('#member-sidebar')).toBeInTheDocument();

      // Simulate PART event
      updateChannelUsers('net1', '#general', 'PART', 'me');
      flushSync();

      expect(document.querySelector('#member-sidebar')).not.toBeInTheDocument();
      expect(document.querySelector('#wrap')?.classList.contains('has-members')).toBe(false);
    });

    it('shows member list after rejoin', async () => {
      const net = createNetwork({ networkId: 'net1', currentNick: 'me' });
      net.buffers.push(createBuffer({ name: '#general', isJoined: false }));
      ircState.networks.push(net);
      ircState.activeBuffer.networkId = 'net1';
      ircState.activeBuffer.bufferName = '#general';
      flushSync();

      render(App);
      expect(document.querySelector('#member-sidebar')).not.toBeInTheDocument();

      // Simulate JOIN event
      updateChannelUsers('net1', '#general', 'JOIN', 'me');
      flushSync();

      expect(document.querySelector('#member-sidebar')).toBeInTheDocument();
      expect(document.querySelector('#wrap')?.classList.contains('has-members')).toBe(true);
    });

    it('shows member list for server buffer without members section', async () => {
      const net = createNetwork({ networkId: 'net1' });
      net.buffers.push(createBuffer({ name: '_server', type: 'server' }));
      ircState.networks.push(net);
      ircState.activeBuffer.networkId = 'net1';
      ircState.activeBuffer.bufferName = '_server';
      flushSync();

      render(App);
      expect(document.querySelector('#member-sidebar')).not.toBeInTheDocument();
      expect(document.querySelector('#wrap')?.classList.contains('has-members')).toBe(false);
    });
  });

  it('shows keyboard shortcuts page at /?/shortcuts route', async () => {
    history.replaceState({}, '', '/?/shortcuts');
    render(App);
    await expect.element(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeInTheDocument();
    await expect.element(page.getByText('Switch to previous buffer')).toBeInTheDocument();
    await expect.element(page.getByText('Selected IRC commands')).toBeInTheDocument();
  });
});
