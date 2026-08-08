import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page, userEvent } from 'vitest/browser';
import UserPopup from './UserPopup.svelte';
import { ircState } from '../stores/ircStore.svelte';
import { createNetwork, createBuffer, createMember } from '../test/factories';

describe('UserPopup', () => {
  let mockSendRaw: ReturnType<typeof vi.fn>;

  function setupChannelBuffer() {
    const network = createNetwork();
    const buf = createBuffer({ name: '#chan' });
    network.buffers.push(buf);
    ircState.networks.push(network);
    ircState.activeBuffer.networkId = network.networkId;
    ircState.activeBuffer.bufferName = '#chan';
    return network;
  }

  beforeEach(() => {
    ircState.networks.length = 0;
    ircState.activeBuffer.networkId = null;
    ircState.activeBuffer.bufferName = null;
    mockSendRaw = vi.fn();
    vi.clearAllMocks();
  });

  it('renders nick', async () => {
    setupChannelBuffer();
    render(UserPopup, { props: { nick: 'Alice', x: 0, y: 0, onClose: vi.fn(), onSwitchBuffer: vi.fn(), onSendRaw: mockSendRaw } });
    await expect.element(page.getByText('Alice')).toBeInTheDocument();
  });

  it('renders WHOIS action', async () => {
    setupChannelBuffer();
    render(UserPopup, { props: { nick: 'Alice', x: 0, y: 0, onClose: vi.fn(), onSwitchBuffer: vi.fn(), onSendRaw: mockSendRaw } });
    await expect.element(page.getByRole('button', { name: 'WHOIS' })).toBeInTheDocument();
  });

  it('renders message form', async () => {
    setupChannelBuffer();
    render(UserPopup, { props: { nick: 'Alice', x: 0, y: 0, onClose: vi.fn(), onSwitchBuffer: vi.fn(), onSendRaw: mockSendRaw } });
    await expect.element(page.getByText('Send a message')).toBeInTheDocument();
  });

  it('renders Op/Voice actions when user has no special prefix', async () => {
    setupChannelBuffer();
    render(UserPopup, { props: { nick: 'Alice', x: 0, y: 0, onClose: vi.fn(), onSwitchBuffer: vi.fn(), onSendRaw: mockSendRaw } });
    const menu = document.querySelector('#memberContextMenu');
    const buttons = Array.from(menu?.querySelectorAll('button') || []).map(b => b.textContent?.trim());
    expect(buttons).toContain('Op');
    expect(buttons).toContain('Voice');
    expect(buttons).not.toContain('Deop');
    expect(buttons).not.toContain('Devoice');
  });

  it('renders Deop/Devoice actions when user has op/voice', async () => {
    setupChannelBuffer();
    render(UserPopup, {
      props: {
        nick: 'Alice',
        member: createMember({ nick: 'Alice', prefix: '@', category: 'OP' }),
        x: 0, y: 0,
        onClose: vi.fn(),
        onSwitchBuffer: vi.fn(),
        onSendRaw: mockSendRaw,
      },
    });
    const menu = document.querySelector('#memberContextMenu');
    const buttons = Array.from(menu?.querySelectorAll('button') || []).map(b => b.textContent?.trim());
    expect(buttons).toContain('Deop');
    expect(buttons).not.toContain('Op');
  });

  it('renders Kick/Ban actions in channel', async () => {
    setupChannelBuffer();
    render(UserPopup, { props: { nick: 'Alice', x: 0, y: 0, onClose: vi.fn(), onSwitchBuffer: vi.fn(), onSendRaw: mockSendRaw } });
    await expect.element(page.getByRole('button', { name: 'Kick' })).toBeInTheDocument();
    await expect.element(page.getByRole('button', { name: 'Ban' })).toBeInTheDocument();
  });

  it('hides channel actions when not in a channel', async () => {
    const network = createNetwork();
    const buf = createBuffer({ name: 'Alice', type: 'query' });
    network.buffers.push(buf);
    ircState.networks.push(network);
    ircState.activeBuffer.networkId = network.networkId;
    ircState.activeBuffer.bufferName = 'Alice';
    render(UserPopup, { props: { nick: 'Alice', x: 0, y: 0, onClose: vi.fn(), onSwitchBuffer: vi.fn(), onSendRaw: mockSendRaw } });
    await expect.element(page.getByRole('button', { name: 'Op', exact: true })).not.toBeInTheDocument();
    await expect.element(page.getByRole('button', { name: 'Kick' })).not.toBeInTheDocument();
  });

  it('calls sendRaw for WHOIS and registers pending intent', async () => {
    const network = setupChannelBuffer();
    const onClose = vi.fn();
    ircState.pendingWhois.clear();
    render(UserPopup, { props: { nick: 'Alice', x: 0, y: 0, onClose, onSwitchBuffer: vi.fn(), onSendRaw: mockSendRaw } });
    await userEvent.click(page.getByRole('button', { name: 'WHOIS' }));
    expect(mockSendRaw).toHaveBeenCalledOnce();
    expect(mockSendRaw).toHaveBeenCalledWith(network.networkId, 'WHOIS Alice');
    expect(onClose).toHaveBeenCalledOnce();
    // The frontend gates the WHOIS overlay on pendingWhois so the server's
    // automatic join-time WHOISes don't pop up unprompted. Registering
    // "alice" here is what allows the next 318 response to be shown.
    expect(ircState.pendingWhois.has('alice')).toBe(true);
  });

  it('calls onSwitchBuffer when clicking Open', async () => {
    const network = setupChannelBuffer();
    const onClose = vi.fn();
    const onSwitchBuffer = vi.fn();
    render(UserPopup, { props: { nick: 'Alice', x: 0, y: 0, onClose, onSwitchBuffer, onSendRaw: mockSendRaw } });
    await userEvent.click(page.getByRole('button', { name: 'Open' }));
    expect(onSwitchBuffer).toHaveBeenCalledOnce();
    expect(onSwitchBuffer).toHaveBeenCalledWith(network.networkId, 'Alice');
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('calls onClose', async () => {
    setupChannelBuffer();
    const onClose = vi.fn();
    render(UserPopup, { props: { nick: 'Alice', x: 0, y: 0, onClose, onSwitchBuffer: vi.fn(), onSendRaw: mockSendRaw } });
    await userEvent.click(page.getByRole('button', { name: 'WHOIS' }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('sends a message via the "Send a message" form', async () => {
    const network = setupChannelBuffer();
    const onClose = vi.fn();
    const onSwitchBuffer = vi.fn();
    const mockSendMessage = vi.fn();
    render(UserPopup, { props: { nick: 'Alice', x: 0, y: 0, onClose, onSwitchBuffer, onSendMessage: mockSendMessage, onSendRaw: mockSendRaw } });

    const textbox = page.getByRole('textbox');
    await expect.element(textbox).toBeInTheDocument();

    await userEvent.fill(textbox, 'Hello from the popup!');
    await userEvent.keyboard('{Enter}');

    expect(mockSendMessage).toHaveBeenCalledOnce();
    expect(mockSendMessage).toHaveBeenCalledWith(network.networkId, 'Alice', 'Hello from the popup!');
    expect(mockSendRaw).not.toHaveBeenCalled();
    expect(onSwitchBuffer).toHaveBeenCalledOnce();
    expect(onSwitchBuffer).toHaveBeenCalledWith(network.networkId, 'Alice');
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('sends a message via clicking the Send button', async () => {
    const network = setupChannelBuffer();
    const onClose = vi.fn();
    const onSwitchBuffer = vi.fn();
    const mockSendMessage = vi.fn();
    render(UserPopup, { props: { nick: 'Alice', x: 0, y: 0, onClose, onSwitchBuffer, onSendMessage: mockSendMessage, onSendRaw: mockSendRaw } });

    const textbox = page.getByRole('textbox');
    await userEvent.fill(textbox, 'Hello via button!');
    const btn = document.querySelector('.send-btn') as HTMLElement;
    await userEvent.click(btn);

    expect(mockSendMessage).toHaveBeenCalledOnce();
    expect(mockSendMessage).toHaveBeenCalledWith(network.networkId, 'Alice', 'Hello via button!');
    expect(onSwitchBuffer).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });
});
