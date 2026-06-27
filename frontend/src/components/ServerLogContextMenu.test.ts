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
}));

import { sendRaw } from '/src/stores/wsConnection.svelte.ts';
import { reconnectNetwork, disconnectNetwork } from '/src/stores/api';

const sendRawMock = sendRaw as unknown as ReturnType<typeof vi.fn>;
const reconnectMock = reconnectNetwork as unknown as ReturnType<typeof vi.fn>;
const disconnectMock = disconnectNetwork as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  ircState.networks.length = 0;
  ircState.activeBuffer.networkId = null;
  ircState.activeBuffer.bufferName = null;
  ircState.overlay = { type: null, data: null };
  Object.keys(clearedAtMap).forEach((k) => delete (clearedAtMap as Record<string, unknown>)[k]);
  sendRawMock.mockClear();
  reconnectMock.mockClear();
  disconnectMock.mockClear();
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
    await expect.element(page.getByRole('button', { name: 'Edit…' })).toBeInTheDocument();
    await expect.element(page.getByRole('button', { name: 'Ignore list…' })).toBeInTheDocument();
    await expect.element(page.getByRole('button', { name: 'Download logs…' })).toBeInTheDocument();
    await expect.element(page.getByRole('button', { name: 'Delete active private messages…' })).toBeInTheDocument();
    await expect.element(page.getByText('Show unread message indicator')).toBeInTheDocument();
    await expect.element(page.getByText('Mark as read automatically')).toBeInTheDocument();
    await expect.element(page.getByText('Mute notifications')).toBeInTheDocument();
    await expect.element(page.getByText('Group repeated disconnects')).toBeInTheDocument();
    await expect.element(page.getByText('Format colours')).toBeInTheDocument();
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

  it('Clear backlog calls setClearedAt for the _server buffer and closes menu', async () => {
    setupConnectedNetwork();
    const buf = ircState.networks[0].buffers[0];
    const onClose = vi.fn();
    render(ServerLogContextMenu, {
      props: { x: 100, y: 100, buf, onClose, onJoinChannel: vi.fn(), onEditNetwork: vi.fn() },
    });
    const before = Date.now();
    await userEvent.click(page.getByRole('button', { name: 'Clear backlog' }));
    const after = Date.now();
    const stored = clearedAtMap['net1:_server'];
    expect(typeof stored).toBe('number');
    expect(stored).toBeGreaterThanOrEqual(before);
    expect(stored).toBeLessThanOrEqual(after);
    expect(onClose).toHaveBeenCalled();
  });
});
