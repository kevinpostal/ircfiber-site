import { describe, expect, it, beforeEach, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page, userEvent } from 'vitest/browser';
import ConnectionStatus from './ConnectionStatus.svelte';
import { ircState } from '../stores/ircStore.svelte';
import { createNetwork, createBuffer } from '../test/factories';

describe('ConnectionStatus', () => {
  let mockSendRaw: ReturnType<typeof vi.fn>;
  let mockReconnect: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    ircState.networks.length = 0;
    ircState.activeBuffer.networkId = null;
    ircState.activeBuffer.bufferName = null;
    mockSendRaw = vi.fn();
    mockReconnect = vi.fn(async () => undefined);
    vi.clearAllMocks();
  });

  it('renders away banner when network isAway', async () => {
    const net = createNetwork({ networkId: 'net1', isAway: true, connected: true });
    net.buffers.push(createBuffer({ name: '#chan' }));
    ircState.networks.push(net);
    ircState.activeBuffer.networkId = 'net1';
    ircState.activeBuffer.bufferName = '#chan';
    render(ConnectionStatus, { props: { onSendRaw: mockSendRaw, onReconnect: mockReconnect } });
    await expect.element(page.getByText('Away')).toBeInTheDocument();
    await expect.element(page.getByText(/Click to come back/)).toBeInTheDocument();
  });

  it('renders disconnected banner when not connected', async () => {
    const net = createNetwork({
      networkId: 'net1',
      connected: false,
      connectionState: 'disconnected',
      disconnectReason: 'Connection reset by peer',
    });
    net.buffers.push(createBuffer({ name: '#chan' }));
    ircState.networks.push(net);
    ircState.activeBuffer.networkId = 'net1';
    ircState.activeBuffer.bufferName = '#chan';
    render(ConnectionStatus, { props: { onSendRaw: mockSendRaw, onReconnect: mockReconnect } });
    await expect.element(page.getByText(/Click to reconnect/)).toBeInTheDocument();
  });

  it('shows disconnect reason', async () => {
    const net = createNetwork({
      networkId: 'net1',
      connected: false,
      connectionState: 'disconnected',
      disconnectReason: 'Network unreachable',
    });
    net.buffers.push(createBuffer({ name: '#chan' }));
    ircState.networks.push(net);
    ircState.activeBuffer.networkId = 'net1';
    ircState.activeBuffer.bufferName = '#chan';
    render(ConnectionStatus, { props: { onSendRaw: mockSendRaw, onReconnect: mockReconnect } });
    await expect.element(page.getByText('Network unreachable')).toBeInTheDocument();
  });

  it('calls sendRaw on "come back" click', async () => {
    const net = createNetwork({ networkId: 'net1', isAway: true, connected: true });
    net.buffers.push(createBuffer({ name: '#chan' }));
    ircState.networks.push(net);
    ircState.activeBuffer.networkId = 'net1';
    ircState.activeBuffer.bufferName = '#chan';
    render(ConnectionStatus, { props: { onSendRaw: mockSendRaw, onReconnect: mockReconnect } });
    await page.getByText('Away').click();
    expect(mockSendRaw).toHaveBeenCalledWith('net1', 'AWAY');
  });

  it('calls reconnectNetwork on reconnect click', async () => {
    const net = createNetwork({
      networkId: 'net1',
      connected: false,
      connectionState: 'disconnected',
      disconnectReason: 'Connection reset',
    });
    net.buffers.push(createBuffer({ name: '#chan' }));
    ircState.networks.push(net);
    ircState.activeBuffer.networkId = 'net1';
    ircState.activeBuffer.bufferName = '#chan';
    render(ConnectionStatus, { props: { onSendRaw: mockSendRaw, onReconnect: mockReconnect } });
    await page.getByText('Connection reset').click();
    expect(mockReconnect).toHaveBeenCalledWith('net1');
  });
});
