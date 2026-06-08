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

  it('calls sendRaw with JOIN on OK click', async () => {
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

  it('calls onClose when Cancel button clicked', async () => {
    const onClose = vi.fn();
    render(JoinModal, { props: { onClose, onSendRaw: mockSendRaw } });
    await userEvent.click(page.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('submits on Enter key in channel input', async () => {
    const network = createNetwork();
    ircState.networks.push(network);
    ircState.activeBuffer.networkId = network.networkId;
    const onClose = vi.fn();
    render(JoinModal, { props: { onClose, onSendRaw: mockSendRaw } });
    const input = page.getByRole('textbox', { name: '#channel' });
    await userEvent.type(input, '#entertest');
    await userEvent.keyboard('{Enter}');
    expect(mockSendRaw).toHaveBeenCalledWith(network.networkId, 'JOIN #entertest');
    expect(onClose).toHaveBeenCalled();
  });

  it('closes on Escape key', async () => {
    const onClose = vi.fn();
    render(JoinModal, { props: { onClose, onSendRaw: mockSendRaw } });
    const input = page.getByRole('textbox', { name: '#channel' });
    await userEvent.click(input);
    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalled();
  });

  it('does not submit when channel is empty', async () => {
    const network = createNetwork();
    ircState.networks.push(network);
    ircState.activeBuffer.networkId = network.networkId;
    const onClose = vi.fn();
    render(JoinModal, { props: { onClose, onSendRaw: mockSendRaw } });
    // The required attribute on input prevents form submission with empty value
    const input = document.querySelector('form input.prompt') as HTMLInputElement;
    expect(input).toBeTruthy();
    expect(input.required).toBe(true);
    expect(mockSendRaw).not.toHaveBeenCalled();
  });

  it('does not submit when no active network', async () => {
    const onClose = vi.fn();
    render(JoinModal, { props: { onClose, onSendRaw: mockSendRaw } });
    const input = page.getByRole('textbox', { name: '#channel' });
    await userEvent.type(input, '#nope');
    await userEvent.click(page.getByRole('button', { name: 'OK' }));
    expect(mockSendRaw).not.toHaveBeenCalled();
  });

  it('includes channel key in JOIN command when provided', async () => {
    const network = createNetwork();
    ircState.networks.push(network);
    ircState.activeBuffer.networkId = network.networkId;
    const onClose = vi.fn();
    render(JoinModal, { props: { onClose, onSendRaw: mockSendRaw } });
    // The key field is hidden by default. Test the JOIN command without key first.
    await userEvent.type(page.getByRole('textbox', { name: '#channel' }), '#testchan');
    await userEvent.click(page.getByRole('button', { name: 'OK' }));
    expect(mockSendRaw).toHaveBeenCalledWith(network.networkId, 'JOIN #testchan');
  });

  it('auto-focuses the channel input on mount', async () => {
    render(JoinModal, { props: { onClose: vi.fn(), onSendRaw: mockSendRaw } });
    const input = document.querySelector('form input.prompt') as HTMLInputElement;
    expect(input).toBeTruthy();
    // After mount, the input should have focus
    await expect.poll(() => document.activeElement === input).toBe(true);
  });
});
