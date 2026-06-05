import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page, userEvent } from 'vitest/browser';
import JoinModal from './JoinModal.svelte';
import { ircState } from '../stores/ircStore.svelte';
import { createNetwork } from '../test/factories';

describe('JoinModal', () => {
  let mockSendRaw: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    ircState.networks.length = 0;
    ircState.activeBuffer.networkId = null;
    ircState.activeBuffer.bufferName = null;
    mockSendRaw = vi.fn();
    vi.clearAllMocks();
  });

  it('renders channel input', async () => {
    render(JoinModal, { props: { onClose: vi.fn(), onSendRaw: mockSendRaw } });
    await expect.element(page.getByRole('textbox', { name: '#channel' })).toBeInTheDocument();
  });

  it('renders network label', async () => {
    const network = createNetwork({ name: 'Libera', host: 'irc.libera.chat', port: 6697 });
    ircState.networks.push(network);
    ircState.activeBuffer.networkId = network.networkId;
    render(JoinModal, { props: { onClose: vi.fn(), onSendRaw: mockSendRaw } });
    await expect.element(page.getByText('Libera (irc.libera.chat:6697)')).toBeInTheDocument();
  });

  it('calls sendRaw with JOIN on submit', async () => {
    const network = createNetwork();
    ircState.networks.push(network);
    ircState.activeBuffer.networkId = network.networkId;
    const onClose = vi.fn();
    render(JoinModal, { props: { onClose, onSendRaw: mockSendRaw } });
    await userEvent.type(page.getByRole('textbox', { name: '#channel' }), '#testchan');
    await userEvent.click(page.getByRole('button', { name: 'OK' }));
    expect(mockSendRaw).toHaveBeenCalledOnce();
    expect(mockSendRaw).toHaveBeenCalledWith(network.networkId, 'JOIN #testchan');
  });

  it('calls setActiveBuffer on submit', async () => {
    const network = createNetwork();
    ircState.networks.push(network);
    ircState.activeBuffer.networkId = network.networkId;
    const onClose = vi.fn();
    render(JoinModal, { props: { onClose, onSendRaw: mockSendRaw } });
    await userEvent.type(page.getByRole('textbox', { name: '#channel' }), '#testchan');
    await userEvent.click(page.getByRole('button', { name: 'OK' }));
    expect(ircState.activeBuffer.bufferName).toBe('#testchan');
  });

  it('calls onClose on submit', async () => {
    const network = createNetwork();
    ircState.networks.push(network);
    ircState.activeBuffer.networkId = network.networkId;
    const onClose = vi.fn();
    render(JoinModal, { props: { onClose, onSendRaw: mockSendRaw } });
    await userEvent.type(page.getByRole('textbox', { name: '#channel' }), '#testchan');
    await userEvent.click(page.getByRole('button', { name: 'OK' }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('calls onClose when close button clicked', async () => {
    const onClose = vi.fn();
    render(JoinModal, { props: { onClose, onSendRaw: mockSendRaw } });
    await userEvent.click(page.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledOnce();
  });
});
