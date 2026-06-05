import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page, userEvent } from 'vitest/browser';
import NetworkForm from './NetworkForm.svelte';
import { ircState } from '../stores/ircStore.svelte';
import { createNetwork } from '../test/factories';

describe('NetworkForm', () => {
  let mockAddNetwork: ReturnType<typeof vi.fn>;
  let mockUpdateNetwork: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    ircState.networks.length = 0;
    mockAddNetwork = vi.fn(async () => undefined);
    mockUpdateNetwork = vi.fn(async () => undefined);
    vi.clearAllMocks();
  });

  it('renders empty form in add mode', async () => {
    render(NetworkForm, { props: { mode: 'add', networkId: null, onClose: vi.fn(), onAddNetwork: mockAddNetwork, onUpdateNetwork: mockUpdateNetwork } });
    await expect.element(page.getByRole('heading', { name: 'Join a new network' })).toBeInTheDocument();
    await expect.element(page.getByLabelText('Network name')).toHaveValue('');
    await expect.element(page.getByLabelText('Hostname')).toHaveValue('');
    await expect.element(page.getByLabelText('Nickname')).toHaveValue('');
  });

  it('pre-fills form in edit mode', async () => {
    const network = createNetwork({
      name: 'TestNet',
      host: 'irc.test.net',
      port: 6667,
      tls: 'disabled',
      nick: 'TesterNick',
      realName: 'Real Name',
    });
    ircState.networks.push(network);
    render(NetworkForm, { props: { mode: 'edit', networkId: network.networkId, onClose: vi.fn(), onAddNetwork: mockAddNetwork, onUpdateNetwork: mockUpdateNetwork } });
    await expect.element(page.getByRole('heading', { name: 'Edit network' })).toBeInTheDocument();
    await expect.element(page.getByLabelText('Network name')).toHaveValue('TestNet');
    await expect.element(page.getByLabelText('Hostname')).toHaveValue('irc.test.net');
    await expect.element(page.getByLabelText('Nickname')).toHaveValue('TesterNick');
  });

  it('calls addNetwork on submit in add mode', async () => {
    const onClose = vi.fn();
    render(NetworkForm, { props: { mode: 'add', networkId: null, onClose, onAddNetwork: mockAddNetwork, onUpdateNetwork: mockUpdateNetwork } });
    await userEvent.type(page.getByLabelText('Network name'), 'NewNet');
    await userEvent.type(page.getByLabelText('Hostname'), 'irc.new.net');
    await userEvent.type(page.getByLabelText('Nickname'), 'MyNick');
    await userEvent.click(page.getByRole('button', { name: 'Join network' }));
    expect(mockAddNetwork).toHaveBeenCalledOnce();
    expect(mockAddNetwork).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'NewNet', host: 'irc.new.net', nick: 'MyNick' })
    );
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('calls updateNetwork on submit in edit mode', async () => {
    const network = createNetwork({ name: 'OldNet', host: 'irc.old.net', nick: 'OldNick' });
    ircState.networks.push(network);
    const onClose = vi.fn();
    render(NetworkForm, { props: { mode: 'edit', networkId: network.networkId, onClose, onAddNetwork: mockAddNetwork, onUpdateNetwork: mockUpdateNetwork } });
    await userEvent.clear(page.getByLabelText('Network name'));
    await userEvent.type(page.getByLabelText('Network name'), 'UpdatedNet');
    await userEvent.click(page.getByRole('button', { name: 'Save changes' }));
    expect(mockUpdateNetwork).toHaveBeenCalledOnce();
    expect(mockUpdateNetwork).toHaveBeenCalledWith(
      network.networkId,
      expect.objectContaining({ name: 'UpdatedNet' })
    );
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('calls onClose when close clicked', async () => {
    const onClose = vi.fn();
    render(NetworkForm, { props: { mode: 'add', networkId: null, onClose, onAddNetwork: mockAddNetwork, onUpdateNetwork: mockUpdateNetwork } });
    await userEvent.click(page.getByRole('button', { name: '×' }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('shows validation for required fields', async () => {
    render(NetworkForm, { props: { mode: 'add', networkId: null, onClose: vi.fn(), onAddNetwork: mockAddNetwork, onUpdateNetwork: mockUpdateNetwork } });
    const form = document.querySelector('form') as HTMLFormElement;
    expect(form.checkValidity()).toBe(false);
    const nameInput = page.getByLabelText('Network name');
    expect((nameInput.element() as HTMLInputElement).required).toBe(true);
  });
});
