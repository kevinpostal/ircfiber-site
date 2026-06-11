import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page, userEvent } from 'vitest/browser';
import ChannelContextMenu from './ChannelContextMenu.svelte';
import { ircState } from '../stores/ircStore.svelte';
import { archivedMap, bufferPrefsMap, pinnedMap } from '../stores/preferences.svelte';
import { createNetwork, createBuffer } from '../test/factories';

vi.mock('/src/stores/wsConnection.svelte.ts', () => ({
  sendRaw: vi.fn(),
}));

vi.mock('/src/stores/api.ts', () => ({
  pinChannel: vi.fn(async () => undefined),
  unpinChannel: vi.fn(async () => undefined),
  archiveChannel: vi.fn(async () => undefined),
  unarchiveChannel: vi.fn(async () => undefined),
}));

import { sendRaw } from '/src/stores/wsConnection.svelte.ts';
const sendRawMock = sendRaw as unknown as ReturnType<typeof vi.fn>;

import { pinChannel, unpinChannel } from '/src/stores/api.ts';
const pinChannelMock = pinChannel as unknown as ReturnType<typeof vi.fn>;
const unpinChannelMock = unpinChannel as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  ircState.networks.length = 0;
  ircState.activeBuffer.networkId = null;
  ircState.activeBuffer.bufferName = null;
  Object.keys(archivedMap).forEach((k) => delete (archivedMap as Record<string, unknown>)[k]);
  Object.keys(bufferPrefsMap).forEach((k) => delete (bufferPrefsMap as Record<string, unknown>)[k]);
  Object.keys(pinnedMap).forEach((k) => delete (pinnedMap as Record<string, unknown>)[k]);
  sendRawMock.mockClear();
  pinChannelMock.mockClear();
  unpinChannelMock.mockClear();
  vi.clearAllMocks();
});

describe('ChannelContextMenu', () => {
  it('renders menu items', async () => {
    const network = createNetwork();
    ircState.networks.push(network);
    ircState.activeBuffer.networkId = network.networkId;
    const buf = createBuffer({ name: '#chan' });
    render(ChannelContextMenu, {
      props: { x: 100, y: 100, buf, onClose: vi.fn(), onToggleMembers: vi.fn(), memberPanelOpen: false },
    });
    await expect.element(page.getByRole('button', { name: 'Set topic…' })).toBeInTheDocument();
    await expect.element(page.getByRole('button', { name: 'Invite…' })).toBeInTheDocument();
    await expect.element(page.getByRole('button', { name: 'Leave' })).toBeInTheDocument();
    await expect.element(page.getByRole('button', { name: 'Archive' })).toBeInTheDocument();
  });

  it('calls onClose when item clicked', async () => {
    const network = createNetwork();
    ircState.networks.push(network);
    ircState.activeBuffer.networkId = network.networkId;
    const buf = createBuffer({ name: '#chan' });
    const onClose = vi.fn();
    render(ChannelContextMenu, {
      props: { x: 100, y: 100, buf, onClose, onToggleMembers: vi.fn(), memberPanelOpen: false },
    });
    await userEvent.click(page.getByRole('button', { name: 'Set topic…' }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('shows rejoin when buffer is not joined', async () => {
    const network = createNetwork({ connected: true });
    ircState.networks.push(network);
    ircState.activeBuffer.networkId = network.networkId;
    const buf = createBuffer({ name: '#parted', isJoined: false });
    render(ChannelContextMenu, {
      props: { x: 100, y: 100, buf, onClose: vi.fn(), onToggleMembers: vi.fn(), memberPanelOpen: false },
    });
    await expect.element(page.getByRole('button', { name: 'Rejoin' })).toBeInTheDocument();
  });

  it('hides rejoin when buffer is joined and connected', async () => {
    const network = createNetwork({ connected: true });
    ircState.networks.push(network);
    ircState.activeBuffer.networkId = network.networkId;
    const buf = createBuffer({ name: '#joined', isJoined: true });
    render(ChannelContextMenu, {
      props: { x: 100, y: 100, buf, onClose: vi.fn(), onToggleMembers: vi.fn(), memberPanelOpen: false },
    });
    await expect.element(page.getByRole('button', { name: 'Rejoin' })).not.toBeInTheDocument();
  });

  it('shows archive when buffer is not archived', async () => {
    const network = createNetwork();
    ircState.networks.push(network);
    ircState.activeBuffer.networkId = network.networkId;
    const buf = createBuffer({ name: '#chan' });
    render(ChannelContextMenu, {
      props: { x: 100, y: 100, buf, onClose: vi.fn(), onToggleMembers: vi.fn(), memberPanelOpen: false },
    });
    await expect.element(page.getByRole('button', { name: 'Archive', exact: true })).toBeInTheDocument();
    await expect.element(page.getByRole('button', { name: 'Unarchive', exact: true })).not.toBeInTheDocument();
  });

  it('shows unarchive when buffer is archived', async () => {
    const network = createNetwork();
    ircState.networks.push(network);
    ircState.activeBuffer.networkId = network.networkId;
    ircState.activeBuffer.bufferName = '#chan';
    const buf = createBuffer({ name: '#chan' });
    archivedMap[`${network.networkId}:#chan`] = true;
    render(ChannelContextMenu, {
      props: { x: 100, y: 100, buf, onClose: vi.fn(), onToggleMembers: vi.fn(), memberPanelOpen: false },
    });
    // Use querySelector because getByRole excludes hidden elements and the Archive
    // button is hidden when archived; the Unarchive button is visible.
    const menu = document.querySelector('#channelContextMenu');
    const buttons = menu?.querySelectorAll('button');
    const buttonTexts = Array.from(buttons || []).map(b => b.textContent?.trim());
    expect(buttonTexts).toContain('Unarchive');
    const archiveLi = menu?.querySelector('li.hide');
    expect(archiveLi?.getAttribute('style')?.includes('display: none')).toBe(true);
  });

  it('persists "showUnread" toggle so it survives a refresh', async () => {
    const network = createNetwork({ networkId: 'net1' });
    ircState.networks.push(network);
    ircState.activeBuffer.networkId = network.networkId;
    const buf = createBuffer({ name: '#chan' });
    render(ChannelContextMenu, {
      props: { x: 100, y: 100, buf, onClose: vi.fn(), onToggleMembers: vi.fn(), memberPanelOpen: false },
    });

    // Initially checked (default)
    const button = page.getByRole('button', { name: /Show unread message indicator/ }).element() as HTMLButtonElement;
    expect(button.getAttribute('aria-pressed')).toBe('true');

    // Click to toggle off
    await userEvent.click(button);
    expect(button.getAttribute('aria-pressed')).toBe('false');

    // Persisted in the prefs map
    expect(bufferPrefsMap['net1:#chan']?.showUnread).toBe(false);
  });

  it('reads "showUnread" from persisted prefs on mount', async () => {
    // Simulate a previous session having toggled showUnread off
    bufferPrefsMap['net1:#chan'] = { showUnread: false };

    const network = createNetwork({ networkId: 'net1' });
    ircState.networks.push(network);
    ircState.activeBuffer.networkId = network.networkId;
    const buf = createBuffer({ name: '#chan' });
    render(ChannelContextMenu, {
      props: { x: 100, y: 100, buf, onClose: vi.fn(), onToggleMembers: vi.fn(), memberPanelOpen: false },
    });

    const button = page.getByRole('button', { name: /Show unread message indicator/ }).element() as HTMLButtonElement;
    // Should reflect the persisted (off) state, not the default (on)
    expect(button.getAttribute('aria-pressed')).toBe('false');
  });

  it('Leave sends PART without removing the buffer', async () => {
    const network = createNetwork({ networkId: 'net1' });
    const serverBuf = createBuffer({ name: '_server', type: 'server' });
    const aBuf = createBuffer({ name: '#a' });
    const bBuf = createBuffer({ name: '#b' });
    network.buffers.push(serverBuf, aBuf, bBuf);
    ircState.networks.push(network);
    ircState.activeBuffer.networkId = 'net1';
    ircState.activeBuffer.bufferName = '#a';

    render(ChannelContextMenu, {
      props: { x: 100, y: 100, buf: aBuf, onClose: vi.fn(), onToggleMembers: vi.fn(), memberPanelOpen: false },
    });
    await userEvent.click(page.getByRole('button', { name: 'Leave' }));

    expect(sendRawMock).toHaveBeenCalledWith('net1', 'PART #a');
    const stored = ircState.networks.find((n) => n.networkId === 'net1');
    const remaining = stored?.buffers.map((b) => b.name) ?? [];
    expect(remaining).toEqual(['_server', '#a', '#b']);
  });

  it('Leave does not switch active buffer', async () => {
    const network = createNetwork({ networkId: 'net1' });
    const serverBuf = createBuffer({ name: '_server', type: 'server' });
    const aBuf = createBuffer({ name: '#a' });
    network.buffers.push(serverBuf, aBuf);
    ircState.networks.push(network);
    ircState.activeBuffer.networkId = 'net1';
    ircState.activeBuffer.bufferName = '#a';

    render(ChannelContextMenu, {
      props: { x: 100, y: 100, buf: aBuf, onClose: vi.fn(), onToggleMembers: vi.fn(), memberPanelOpen: false },
    });
    await userEvent.click(page.getByRole('button', { name: 'Leave' }));

    const stored = ircState.networks.find((n) => n.networkId === 'net1');
    const remaining = stored?.buffers.map((b) => b.name) ?? [];
    expect(remaining).toEqual(['_server', '#a']);
    expect(ircState.activeBuffer.bufferName).toBe('#a');
  });

  it('pins and unpins a channel', async () => {
    const network = createNetwork({ networkId: 'net1' });
    const buf = createBuffer({ name: '#chan' });
    network.buffers.push(createBuffer({ name: '_server', type: 'server' }), buf);
    ircState.networks.push(network);
    ircState.activeBuffer.networkId = 'net1';
    ircState.activeBuffer.bufferName = '#chan';

    render(ChannelContextMenu, {
      props: { x: 100, y: 100, buf, onClose: vi.fn(), onToggleMembers: vi.fn(), memberPanelOpen: false },
    });

    // Initially not pinned — button shows "Pin"
    const pinButton = page.getByRole('button', { name: 'Pin', exact: true }).element() as HTMLButtonElement;
    expect(pinButton.getAttribute('aria-pressed')).toBe('false');

    // Click to pin — button text changes to "Unpin"
    await userEvent.click(pinButton);
    const unpinButton = page.getByRole('button', { name: 'Unpin', exact: true }).element() as HTMLButtonElement;
    expect(unpinButton.getAttribute('aria-pressed')).toBe('true');
    expect(pinnedMap['net1:#chan']).toBe(true);
    expect(buf.isPinned).toBe(true);
    expect(pinChannelMock).toHaveBeenCalledWith('net1', '#chan');

    // Click again to unpin — button text changes back to "Pin"
    await userEvent.click(unpinButton);
    const pinButtonAgain = page.getByRole('button', { name: 'Pin', exact: true }).element() as HTMLButtonElement;
    expect(pinButtonAgain.getAttribute('aria-pressed')).toBe('false');
    expect(pinnedMap['net1:#chan']).toBe(false);
    expect(buf.isPinned).toBe(false);
    expect(unpinChannelMock).toHaveBeenCalledWith('net1', '#chan');
  });

  it('unpins a channel that was already pinned', async () => {
    const network = createNetwork({ networkId: 'net1' });
    const buf = createBuffer({ name: '#chan' });
    network.buffers.push(createBuffer({ name: '_server', type: 'server' }), buf);
    ircState.networks.push(network);
    ircState.activeBuffer.networkId = 'net1';
    ircState.activeBuffer.bufferName = '#chan';
    pinnedMap['net1:#chan'] = true;

    render(ChannelContextMenu, {
      props: { x: 100, y: 100, buf, onClose: vi.fn(), onToggleMembers: vi.fn(), memberPanelOpen: false },
    });

    // Should show as pinned — button text is "Unpin"
    const unpinButton = page.getByRole('button', { name: 'Unpin', exact: true }).element() as HTMLButtonElement;
    expect(unpinButton.getAttribute('aria-pressed')).toBe('true');

    // Click to unpin — button text changes to "Pin"
    await userEvent.click(unpinButton);
    const pinButton = page.getByRole('button', { name: 'Pin', exact: true }).element() as HTMLButtonElement;
    expect(pinButton.getAttribute('aria-pressed')).toBe('false');
    expect(pinnedMap['net1:#chan']).toBe(false);
    expect(buf.isPinned).toBe(false);
    expect(unpinChannelMock).toHaveBeenCalledWith('net1', '#chan');
  });
});
