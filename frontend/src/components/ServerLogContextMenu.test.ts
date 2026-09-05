import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page, userEvent } from 'vitest/browser';
import ServerLogContextMenu from './ServerLogContextMenu.svelte';
import { ircState } from '../stores/ircStore.svelte';
import { collapsedMap, clearedAtMap } from '../stores/preferences.svelte';
import { createNetwork, createBuffer } from '../test/factories';

vi.mock('/src/stores/wsConnection.svelte.ts', () => ({
  sendRaw: vi.fn(),
}));

vi.mock('/src/stores/api', () => ({
  reconnectNetwork: vi.fn(async () => undefined),
  disconnectNetwork: vi.fn(async () => undefined),
  archiveChannel: vi.fn(async () => undefined),
  unarchiveChannel: vi.fn(async () => undefined),
  updateCollapsed: vi.fn(async () => undefined),
  updateBufferPrefs: vi.fn(async () => undefined),
  clearBacklog: vi.fn(async () => undefined),
  // ircStore imports this for the WebSocket-sync message normalization
  // path. The tests in this file don't exercise that path, so a
  // pass-through stub is fine.
  normalizeMessage: vi.fn((m: unknown) => m),
}));

import { sendRaw } from '/src/stores/wsConnection.svelte.ts';
import { reconnectNetwork, disconnectNetwork, clearBacklog as apiClearBacklog } from '/src/stores/api';

const sendRawMock = sendRaw as unknown as ReturnType<typeof vi.fn>;
const reconnectMock = reconnectNetwork as unknown as ReturnType<typeof vi.fn>;
const disconnectMock = disconnectNetwork as unknown as ReturnType<typeof vi.fn>;
const clearBacklogMock = apiClearBacklog as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  ircState.networks.length = 0;
  ircState.activeBuffer.networkId = null;
  ircState.activeBuffer.bufferName = null;
  ircState.overlay = { type: null, data: null };
  Object.keys(clearedAtMap).forEach((k) => delete (clearedAtMap as Record<string, unknown>)[k]);
  sendRawMock.mockClear();
  reconnectMock.mockClear();
  disconnectMock.mockClear();
  clearBacklogMock.mockClear();
});

function setupConnectedNetwork(): void {
  const network = createNetwork({ networkId: 'net1', name: 'SuperNETs', connected: true });
  const buf = createBuffer({ name: '_server' });
  network.buffers.push(buf);
  ircState.networks.push(network);
  ircState.activeBuffer.networkId = 'net1';
  ircState.activeBuffer.bufferName = '_server';
}

describe('ServerLogContextMenu', () => {
  it('renders IRCCloud menu items', async () => {
    setupConnectedNetwork();
    const buf = ircState.networks[0].buffers[0];
    render(ServerLogContextMenu, {
      props: { x: 100, y: 100, buf, onClose: vi.fn(), onJoinChannel: vi.fn(), onEditNetwork: vi.fn() },
    });
    await expect.element(page.getByRole('button', { name: 'Join a channel…' })).toBeInTheDocument();

    // Every actionable entry, in DOM order, for a connected non-Fiber,
    // non-collapsed network. Rows the state hides (Reconnect, Expand) carry
    // display:none and are excluded; the "Muted globally" notice li has no
    // button so it never appears here either.
    const items = Array.from(document.querySelectorAll('#serverLogContextMenu li'))
      .filter((li) => (li as HTMLElement).style.display !== 'none')
      .filter((li) => li.querySelector('button') !== null || li.classList.contains('contextMenu__header'))
      .map((li) => (li.textContent ?? '').replace(/\s+/g, ' ').trim());
    expect(items).toEqual([
      'Join a channel…',
      'Channel list…',
      'Edit…',
      'Identify Nickname…',
      'Connect with another client…',
      'Disconnect',
      'Ignore list…',
      'Download logs…',
      'Clear backlog',
      'Collapse',
      'Delete active private messages…',
      'Delete…',
      'Show unread message indicator',
      'Mark as read automatically',
      'Notifications',
      'Mentions only',
      'All messages',
      'Muted',
      'Group repeated disconnects',
      'Format colours',
    ]);

    // The single "Mute notifications" toggle was replaced (commit 648adfc,
    // "per-channel Notifications radios … with global mute guard") by three
    // mutually exclusive modes, so exactly one is pressed at any time.
    const modes = ['.notifMentions', '.notifAll', '.notifMuted'].map(
      (sel) => document.querySelector(sel)?.getAttribute('aria-pressed'),
    );
    expect(modes.filter((v) => v === 'true')).toHaveLength(1);
  });

  it('hides Reconnect when connected, shows Disconnect', async () => {
    setupConnectedNetwork();
    const buf = ircState.networks[0].buffers[0];
    render(ServerLogContextMenu, {
      props: { x: 100, y: 100, buf, onClose: vi.fn(), onJoinChannel: vi.fn(), onEditNetwork: vi.fn() },
    });
    expect((document.querySelector('li.reconnect') as HTMLElement).style.display).toBe('none');
    expect((document.querySelector('li.disconnect') as HTMLElement).style.display).not.toBe('none');
  });

  it('shows Reconnect and hides Disconnect when disconnected', async () => {
    const network = createNetwork({ networkId: 'net1', name: 'SuperNETs', connected: false });
    const buf = createBuffer({ name: '_server' });
    network.buffers.push(buf);
    ircState.networks.push(network);
    ircState.activeBuffer.networkId = 'net1';
    ircState.activeBuffer.bufferName = '_server';

    render(ServerLogContextMenu, {
      props: { x: 100, y: 100, buf, onClose: vi.fn(), onJoinChannel: vi.fn(), onEditNetwork: vi.fn() },
    });
    expect((document.querySelector('li.reconnect') as HTMLElement).style.display).not.toBe('none');
    expect((document.querySelector('li.disconnect') as HTMLElement).style.display).toBe('none');
    expect((document.querySelector('li.delete') as HTMLElement).style.display).not.toBe('none');
  });

  it('shows Delete even when connected', async () => {
    setupConnectedNetwork();
    const buf = ircState.networks[0].buffers[0];
    render(ServerLogContextMenu, {
      props: { x: 100, y: 100, buf, onClose: vi.fn(), onJoinChannel: vi.fn(), onEditNetwork: vi.fn() },
    });
    const li = document.querySelector('li.delete') as HTMLElement;
    expect(li.style.display).not.toBe('none');
    expect(li.getAttribute('aria-disabled')).not.toBe('true');
  });

  it('Collapse button calls onClose (handler ran)', async () => {
    const network = createNetwork({ networkId: 'net1', name: 'SuperNETs', connected: true });
    collapsedMap['net1'] = false;
    const buf = createBuffer({ name: '_server' });
    network.buffers.push(buf);
    ircState.networks.push(network);
    ircState.activeBuffer.networkId = 'net1';
    ircState.activeBuffer.bufferName = '_server';

    const onClose = vi.fn();
    render(ServerLogContextMenu, {
      props: { x: 100, y: 100, buf, onClose, onJoinChannel: vi.fn(), onEditNetwork: vi.fn() },
    });
    await userEvent.click(page.getByRole('button', { name: 'Collapse', exact: true }));
    expect(onClose).toHaveBeenCalled();
  });

  it('shows Expand and hides Collapse when already collapsed', async () => {
    const network = createNetwork({ networkId: 'net1', name: 'SuperNETs', connected: true });
    collapsedMap['net1'] = true;
    const buf = createBuffer({ name: '_server' });
    network.buffers.push(buf);
    ircState.networks.push(network);
    ircState.activeBuffer.networkId = 'net1';
    ircState.activeBuffer.bufferName = '_server';

    render(ServerLogContextMenu, {
      props: { x: 100, y: 100, buf, onClose: vi.fn(), onJoinChannel: vi.fn(), onEditNetwork: vi.fn() },
    });
    expect((document.querySelector('li.collapse') as HTMLElement).style.display).toBe('none');
    expect((document.querySelector('li.expand') as HTMLElement).style.display).not.toBe('none');
  });

  it('Identify Nickname sends PRIVMSG NickServ :IDENTIFY', async () => {
    setupConnectedNetwork();
    const buf = ircState.networks[0].buffers[0];
    render(ServerLogContextMenu, {
      props: { x: 100, y: 100, buf, onClose: vi.fn(), onJoinChannel: vi.fn(), onEditNetwork: vi.fn() },
    });
    await userEvent.click(page.getByRole('button', { name: 'Identify Nickname…' }));
    expect(sendRawMock).toHaveBeenCalledWith('net1', 'PRIVMSG NickServ :IDENTIFY');
  });

  it('Disconnect calls api.disconnectNetwork when active', async () => {
    setupConnectedNetwork();
    const buf = ircState.networks[0].buffers[0];
    render(ServerLogContextMenu, {
      props: { x: 100, y: 100, buf, onClose: vi.fn(), onJoinChannel: vi.fn(), onEditNetwork: vi.fn() },
    });
    await userEvent.click(page.getByRole('button', { name: 'Disconnect', exact: true }));
    expect(disconnectMock).toHaveBeenCalledWith('net1');
  });

  it('Reconnect calls api.reconnectNetwork when inactive', async () => {
    const network = createNetwork({ networkId: 'net1', name: 'SuperNETs', connected: false });
    const buf = createBuffer({ name: '_server' });
    network.buffers.push(buf);
    ircState.networks.push(network);
    ircState.activeBuffer.networkId = 'net1';
    ircState.activeBuffer.bufferName = '_server';

    render(ServerLogContextMenu, {
      props: { x: 100, y: 100, buf, onClose: vi.fn(), onJoinChannel: vi.fn(), onEditNetwork: vi.fn() },
    });
    await userEvent.click(page.getByRole('button', { name: 'Reconnect' }));
    expect(reconnectMock).toHaveBeenCalledWith('net1');
  });

  it('Edit… calls onEditNetwork', async () => {
    setupConnectedNetwork();
    const buf = ircState.networks[0].buffers[0];
    const onEditNetwork = vi.fn();
    render(ServerLogContextMenu, {
      props: { x: 100, y: 100, buf, onClose: vi.fn(), onJoinChannel: vi.fn(), onEditNetwork },
    });
    await userEvent.click(page.getByRole('button', { name: 'Edit…' }));
    expect(onEditNetwork).toHaveBeenCalled();
  });

  it('Connect with another client… calls onBouncer then onClose', async () => {
    setupConnectedNetwork();
    const buf = ircState.networks[0].buffers[0];
    const onBouncer = vi.fn();
    const onClose = vi.fn();
    render(ServerLogContextMenu, {
      props: { x: 100, y: 100, buf, onClose, onJoinChannel: vi.fn(), onEditNetwork: vi.fn(), onBouncer },
    });
    await expect.element(page.getByRole('button', { name: 'Connect with another client…' })).toBeInTheDocument();
    await userEvent.click(page.getByRole('button', { name: 'Connect with another client…' }));
    expect(onBouncer).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it('Join a channel… calls onJoinChannel', async () => {
    setupConnectedNetwork();
    const buf = ircState.networks[0].buffers[0];
    const onJoinChannel = vi.fn();
    render(ServerLogContextMenu, {
      props: { x: 100, y: 100, buf, onClose: vi.fn(), onJoinChannel, onEditNetwork: vi.fn() },
    });
    await userEvent.click(page.getByRole('button', { name: 'Join a channel…' }));
    expect(onJoinChannel).toHaveBeenCalled();
  });

  it('Channel list… calls onChannelList then onClose', async () => {
    setupConnectedNetwork();
    const buf = ircState.networks[0].buffers[0];
    const onChannelList = vi.fn();
    const onClose = vi.fn();
    render(ServerLogContextMenu, {
      props: { x: 100, y: 100, buf, onClose, onJoinChannel: vi.fn(), onEditNetwork: vi.fn(), onChannelList },
    });
    await expect.element(page.getByRole('button', { name: 'Channel list…' })).toBeInTheDocument();
    await userEvent.click(page.getByRole('button', { name: 'Channel list…' }));
    expect(onChannelList).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Delete… opens channel_delete_confirm overlay', async () => {
    const network = createNetwork({ networkId: 'net1', name: 'SuperNETs', connected: false });
    const buf = createBuffer({ name: '_server' });
    network.buffers.push(buf);
    ircState.networks.push(network);
    ircState.activeBuffer.networkId = 'net1';
    ircState.activeBuffer.bufferName = '_server';

    render(ServerLogContextMenu, {
      props: { x: 100, y: 100, buf, onClose: vi.fn(), onJoinChannel: vi.fn(), onEditNetwork: vi.fn() },
    });
    await userEvent.click(page.getByRole('button', { name: 'Delete…' }));
    expect(ircState.overlay.type).toBe('channel_delete_confirm');
  });

  it('Clear backlog purges the _server buffer and hides old messages', async () => {
    setupConnectedNetwork();
    const buf = ircState.networks[0].buffers[0];
    const onClose = vi.fn();
    render(ServerLogContextMenu, {
      props: { x: 100, y: 100, buf, onClose, onJoinChannel: vi.fn(), onEditNetwork: vi.fn() },
    });
    await userEvent.click(page.getByRole('button', { name: 'Clear backlog' }));
    // The component sets clearedAt as a local filter immediately (before
    // the API call), then calls the API to scrub the server-side data.
    // The clearedAt entry persists so the UI shows "nothing to load"
    // instead of re-fetching deleted history from Redis.
    expect(typeof clearedAtMap['net1:_server']).toBe('number');
    expect(clearBacklogMock).toHaveBeenCalledWith('net1', '_server');
    expect(onClose).toHaveBeenCalled();
  });

  it('Clear backlog still closes the menu (and applies the local filter) even if the API delete fails', async () => {
    setupConnectedNetwork();
    const buf = ircState.networks[0].buffers[0];
    clearBacklogMock.mockRejectedValueOnce(new Error('boom'));
    render(ServerLogContextMenu, {
      props: { x: 100, y: 100, buf, onClose: vi.fn(), onJoinChannel: vi.fn(), onEditNetwork: vi.fn() },
    });
    await userEvent.click(page.getByRole('button', { name: 'Clear backlog' }));
    // Microtask settle so the rejected promise surfaces.
    await new Promise(r => setTimeout(r, 0));
    expect(typeof clearedAtMap['net1:_server']).toBe('number');
    expect(clearBacklogMock).toHaveBeenCalledWith('net1', '_server');
  });
});
