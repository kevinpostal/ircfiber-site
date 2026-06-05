import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page, userEvent } from 'vitest/browser';
import ChannelContextMenu from './ChannelContextMenu.svelte';
import { ircState } from '../stores/ircStore.svelte';
import { sendRaw } from '../stores/wsConnection';
import { archivedMap } from '../stores/preferences.svelte';
import { createNetwork, createBuffer } from '../test/factories';

vi.mock('../stores/wsConnection', () => ({
  sendRaw: vi.fn(),
}));

beforeEach(() => {
  ircState.networks.length = 0;
  ircState.activeBuffer.networkId = null;
  ircState.activeBuffer.bufferName = null;
  Object.keys(archivedMap).forEach((k) => delete (archivedMap as Record<string, unknown>)[k]);
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
    const buf = createBuffer({ name: '#chan' });
    archivedMap[`${network.networkId}:#chan`] = true;
    render(ChannelContextMenu, {
      props: { x: 100, y: 100, buf, onClose: vi.fn(), onToggleMembers: vi.fn(), memberPanelOpen: false },
    });
    await expect.element(page.getByRole('button', { name: 'Unarchive', exact: true })).toBeInTheDocument();
    // Archive button is always rendered in this component; only Unarchive is conditional.
    await expect.element(page.getByRole('button', { name: 'Archive', exact: true })).toBeInTheDocument();
  });
});
