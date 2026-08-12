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
    await userEvent.click(page.getByRole('button', { name: 'Save' }));
    expect(mockUpdateNetwork).toHaveBeenCalledOnce();
    expect(mockUpdateNetwork).toHaveBeenCalledWith(
      network.networkId,
      expect.objectContaining({ name: 'UpdatedNet' })
    );
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('calls onClose when Cancel clicked', async () => {
    const onClose = vi.fn();
    render(NetworkForm, { props: { mode: 'add', networkId: null, onClose, onAddNetwork: mockAddNetwork, onUpdateNetwork: mockUpdateNetwork } });
    await userEvent.click(page.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('shows validation for required fields', async () => {
    render(NetworkForm, { props: { mode: 'add', networkId: null, onClose: vi.fn(), onAddNetwork: mockAddNetwork, onUpdateNetwork: mockUpdateNetwork } });
    const form = document.querySelector('form') as HTMLFormElement;
    expect(form.checkValidity()).toBe(false);
    const nameInput = page.getByLabelText('Network name');
    expect((nameInput.element() as HTMLInputElement).required).toBe(true);
  });

  it('Advanced section starts collapsed', async () => {
    render(NetworkForm, { props: { mode: 'add', networkId: null, onClose: vi.fn(), onAddNetwork: mockAddNetwork, onUpdateNetwork: mockUpdateNetwork } });
    // NickServ field is inside Advanced; should not be visible
    expect(document.querySelector('#add-network-nspass')).toBeNull();
  });

  it('Advanced section expands when toggled', async () => {
    render(NetworkForm, { props: { mode: 'add', networkId: null, onClose: vi.fn(), onAddNetwork: mockAddNetwork, onUpdateNetwork: mockUpdateNetwork } });
    const toggle = page.getByRole('button', { name: /Advanced options/ });
    await userEvent.click(toggle);
    await expect.element(page.getByLabelText(/NickServ password/)).toBeInTheDocument();
    await expect.element(page.getByLabelText(/Server password/)).toBeInTheDocument();
    await expect.element(page.getByLabelText(/Commands to run on connect/)).toBeInTheDocument();
  });

  it('Channels to join textarea appears in add mode', async () => {
    render(NetworkForm, { props: { mode: 'add', networkId: null, onClose: vi.fn(), onAddNetwork: mockAddNetwork, onUpdateNetwork: mockUpdateNetwork } });
    const channels = page.getByLabelText(/Channels to join/).element() as HTMLTextAreaElement;
    expect(channels).toBeTruthy();
    expect(channels.tagName).toBe('TEXTAREA');
  });

  it('Channels to join textarea appears in edit mode', async () => {
    const network = createNetwork();
    ircState.networks.push(network);
    render(NetworkForm, { props: { mode: 'edit', networkId: network.networkId, onClose: vi.fn(), onAddNetwork: mockAddNetwork, onUpdateNetwork: mockUpdateNetwork } });
    const channels = page.getByLabelText(/Channels to join/).element() as HTMLTextAreaElement;
    expect(channels).toBeTruthy();
    expect(channels.tagName).toBe('TEXTAREA');
  });

  it('Update mode includes autoJoinChannels in payload as string array', async () => {
    const network = createNetwork();
    ircState.networks.push(network);
    const onClose = vi.fn();
    render(NetworkForm, { props: { mode: 'edit', networkId: network.networkId, onClose, onAddNetwork: mockAddNetwork, onUpdateNetwork: mockUpdateNetwork } });
    await userEvent.click(page.getByRole('button', { name: 'Save' }));
    const call = mockUpdateNetwork.mock.calls[0];
    expect(call[1]).toHaveProperty('autoJoinChannels');
    expect(Array.isArray(call[1].autoJoinChannels)).toBe(true);
    // commands and nspass remain add-only
    expect(call[1]).not.toHaveProperty('commands');
    expect(call[1]).not.toHaveProperty('nspass');
  });

  it('Update mode includes autoJoinDelaySeconds in payload', async () => {
    const network = createNetwork({ autoJoinDelaySeconds: 6 });
    ircState.networks.push(network);
    const onClose = vi.fn();
    render(NetworkForm, { props: { mode: 'edit', networkId: network.networkId, onClose, onAddNetwork: mockAddNetwork, onUpdateNetwork: mockUpdateNetwork } });
    await userEvent.click(page.getByRole('button', { name: 'Save' }));
    const call = mockUpdateNetwork.mock.calls[0];
    expect(call[1]).toHaveProperty('autoJoinDelaySeconds', 6);
  });

  it('Advanced options exposes auto-join delay and pre-fills it', async () => {
    const network = createNetwork({ autoJoinDelaySeconds: 6 });
    ircState.networks.push(network);
    render(NetworkForm, { props: { mode: 'edit', networkId: network.networkId, onClose: vi.fn(), onAddNetwork: mockAddNetwork, onUpdateNetwork: mockUpdateNetwork } });
    await userEvent.click(page.getByRole('button', { name: /Advanced options/ }));
    const delay = page.getByLabelText(/Auto-join delay/).element() as HTMLInputElement;
    expect(delay).toBeTruthy();
    expect(delay.value).toBe('6');
  });

  it('Edit mode pre-fills autoJoinChannels from existing network state', async () => {
    const network = createNetwork({ autoJoinChannels: ['#chat', '#feedback'] });
    ircState.networks.push(network);
    render(NetworkForm, { props: { mode: 'edit', networkId: network.networkId, onClose: vi.fn(), onAddNetwork: mockAddNetwork, onUpdateNetwork: mockUpdateNetwork } });
    const channels = page.getByLabelText(/Channels to join/).element() as HTMLTextAreaElement;
    expect(channels.value).toBe('#chat, #feedback');
  });

  it('Editing channels and submitting parses newline separators', async () => {
    const network = createNetwork();
    ircState.networks.push(network);
    render(NetworkForm, { props: { mode: 'edit', networkId: network.networkId, onClose: vi.fn(), onAddNetwork: mockAddNetwork, onUpdateNetwork: mockUpdateNetwork } });
    const channels = page.getByLabelText(/Channels to join/).element() as HTMLTextAreaElement;
    await userEvent.clear(channels);
    await userEvent.fill(channels, '#superbowl\n#Zod');
    await userEvent.click(page.getByRole('button', { name: 'Save' }));
    const call = mockUpdateNetwork.mock.calls[0];
    expect(call[1].autoJoinChannels).toEqual(['#superbowl', '#zod']);
  });

  it('Editing channels and submitting parses space separators', async () => {
    const network = createNetwork();
    ircState.networks.push(network);
    render(NetworkForm, { props: { mode: 'edit', networkId: network.networkId, onClose: vi.fn(), onAddNetwork: mockAddNetwork, onUpdateNetwork: mockUpdateNetwork } });
    const channels = page.getByLabelText(/Channels to join/).element() as HTMLTextAreaElement;
    await userEvent.clear(channels);
    await userEvent.fill(channels, '#superbowl #zod');
    await userEvent.click(page.getByRole('button', { name: 'Save' }));
    const call = mockUpdateNetwork.mock.calls[0];
    expect(call[1].autoJoinChannels).toEqual(['#superbowl', '#zod']);
  });

  it('Editing channels and submitting parses comma separators (regression)', async () => {
    const network = createNetwork();
    ircState.networks.push(network);
    render(NetworkForm, { props: { mode: 'edit', networkId: network.networkId, onClose: vi.fn(), onAddNetwork: mockAddNetwork, onUpdateNetwork: mockUpdateNetwork } });
    const channels = page.getByLabelText(/Channels to join/).element() as HTMLTextAreaElement;
    await userEvent.clear(channels);
    await userEvent.fill(channels, '#superbowl,#Zod');
    await userEvent.click(page.getByRole('button', { name: 'Save' }));
    const call = mockUpdateNetwork.mock.calls[0];
    expect(call[1].autoJoinChannels).toEqual(['#superbowl', '#zod']);
  });

  it('Reveal toggle shows/hides NickServ password', async () => {
    render(NetworkForm, { props: { mode: 'add', networkId: null, onClose: vi.fn(), onAddNetwork: mockAddNetwork, onUpdateNetwork: mockUpdateNetwork } });
    await userEvent.click(page.getByRole('button', { name: /Advanced options/ }));
    const input = page.getByLabelText(/NickServ password/).element() as HTMLInputElement;
    expect(input.type).toBe('password');
    const reveals = document.querySelectorAll('.passwordRow .reveal input');
    await userEvent.click(reveals[0] as HTMLElement);
    expect(input.type).toBe('text');
  });

  it('Reveal toggle shows/hides Server password independently', async () => {
    render(NetworkForm, { props: { mode: 'add', networkId: null, onClose: vi.fn(), onAddNetwork: mockAddNetwork, onUpdateNetwork: mockUpdateNetwork } });
    await userEvent.click(page.getByRole('button', { name: /Advanced options/ }));
    const nickservInput = page.getByLabelText(/NickServ password/).element() as HTMLInputElement;
    const serverInput = page.getByLabelText(/Server password/).element() as HTMLInputElement;
    expect(nickservInput.type).toBe('password');
    expect(serverInput.type).toBe('password');
    const reveals = document.querySelectorAll('.passwordRow .reveal input');
    expect(reveals.length).toBe(2);
    await userEvent.click(reveals[1] as HTMLElement);
    expect(nickservInput.type).toBe('password');
    expect(serverInput.type).toBe('text');
  });

  it('Escape key closes the form', async () => {
    const onClose = vi.fn();
    render(NetworkForm, { props: { mode: 'add', networkId: null, onClose, onAddNetwork: mockAddNetwork, onUpdateNetwork: mockUpdateNetwork } });
    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalled();
  });

  it('shows error message when save fails', async () => {
    const failingUpdate = vi.fn(async () => {
      throw new Error('Server rejected the request');
    });
    const network = createNetwork();
    ircState.networks.push(network);
    render(NetworkForm, { props: { mode: 'edit', networkId: network.networkId, onClose: vi.fn(), onAddNetwork: mockAddNetwork, onUpdateNetwork: failingUpdate } });
    await userEvent.click(page.getByRole('button', { name: 'Save' }));
    await expect.element(page.getByText('Server rejected the request')).toBeInTheDocument();
  });

  it('disables buttons while submitting', async () => {
    let resolveSave: ((v?: unknown) => void) | undefined;
    const slowAdd = vi.fn(() => new Promise<unknown>((res) => { resolveSave = res; }));
    render(NetworkForm, { props: { mode: 'add', networkId: null, onClose: vi.fn(), onAddNetwork: slowAdd, onUpdateNetwork: mockUpdateNetwork } });
    await userEvent.type(page.getByLabelText('Network name'), 'NewNet');
    await userEvent.type(page.getByLabelText('Hostname'), 'irc.new.net');
    await userEvent.type(page.getByLabelText('Nickname'), 'MyNick');
    const submitBtn = page.getByRole('button', { name: 'Join network' }).element() as HTMLButtonElement;
    const cancelBtn = page.getByRole('button', { name: 'Cancel' }).element() as HTMLButtonElement;
    await userEvent.click(submitBtn);
    expect(submitBtn.disabled).toBe(true);
    expect(cancelBtn.disabled).toBe(true);
    resolveSave?.(undefined);
  });

  it('renders IRCCloud-style section headings with icons', async () => {
    render(NetworkForm, { props: { mode: 'add', networkId: null, onClose: vi.fn(), onAddNetwork: mockAddNetwork, onUpdateNetwork: mockUpdateNetwork } });
    const identityHeading = document.querySelector('.networkEditorHeading__Identity');
    expect(identityHeading).toBeTruthy();
    expect(identityHeading?.textContent).toContain('Your identity');
    expect(identityHeading?.querySelector('i.fa-user')).toBeTruthy();

    await userEvent.click(page.getByRole('button', { name: /Advanced options/ }));
    const advancedHeading = document.querySelector('.addNetworkAdvancedHeading');
    expect(advancedHeading?.querySelector('i.fa-cog')).toBeTruthy();
  });

  it('Save button uses primary class and Cancel uses secondary class', async () => {
    render(NetworkForm, { props: { mode: 'edit', networkId: 'nonexistent', onClose: vi.fn(), onAddNetwork: mockAddNetwork, onUpdateNetwork: mockUpdateNetwork } });
    const saveBtn = document.querySelector('.formButtons .action.primary') as HTMLButtonElement;
    const cancelBtn = document.querySelector('.formButtons .action.secondary') as HTMLButtonElement;
    expect(saveBtn).toBeTruthy();
    expect(cancelBtn).toBeTruthy();
    expect(saveBtn.classList.contains('primary')).toBe(true);
    expect(cancelBtn.classList.contains('secondary')).toBe(true);
    expect(saveBtn.textContent?.trim()).toBe('Save');
    expect(cancelBtn.textContent?.trim()).toBe('Cancel');
  });

  it('shows reconnect note in edit mode', async () => {
    const network = createNetwork();
    ircState.networks.push(network);
    render(NetworkForm, { props: { mode: 'edit', networkId: network.networkId, onClose: vi.fn(), onAddNetwork: mockAddNetwork, onUpdateNetwork: mockUpdateNetwork } });
    await expect.element(page.getByText(/Nickname changes take effect immediately on the live connection/)).toBeInTheDocument();
  });

  it('does not show reconnect note in add mode', async () => {
    render(NetworkForm, { props: { mode: 'add', networkId: null, onClose: vi.fn(), onAddNetwork: mockAddNetwork, onUpdateNetwork: mockUpdateNetwork } });
    expect(document.querySelector('.reconnectNote')).toBeNull();
  });

  it('secure port checkbox toggles TLS state', async () => {
    render(NetworkForm, { props: { mode: 'add', networkId: null, onClose: vi.fn(), onAddNetwork: mockAddNetwork, onUpdateNetwork: mockUpdateNetwork } });
    const checkbox = document.querySelector('#add-network-tls-secure') as HTMLInputElement;
    expect(checkbox).toBeTruthy();
    expect(checkbox.checked).toBe(true);
    await userEvent.click(checkbox);
    expect(checkbox.checked).toBe(false);
  });

  describe('nick change on save (realtime)', () => {
    it('sends NICK raw and optimistically updates currentNick when nick changes', async () => {
      const mockSendRaw = vi.fn();
      const network = createNetwork({ networkId: 'net1', name: 'TestNet', nick: 'OldNick', currentNick: 'OldNick' });
      ircState.networks.push(network);
      render(NetworkForm, {
        props: {
          mode: 'edit',
          networkId: 'net1',
          onClose: vi.fn(),
          onAddNetwork: mockAddNetwork,
          onUpdateNetwork: mockUpdateNetwork,
          onSendRaw: mockSendRaw,
        },
      });
      // Change the nick in the form
      const nickInput = page.getByLabelText('Nickname');
      await userEvent.clear(nickInput);
      await userEvent.type(nickInput, 'NewNick');
      await userEvent.click(page.getByRole('button', { name: 'Save' }));

      // The API was called with the new nick
      expect(mockUpdateNetwork).toHaveBeenCalledWith(
        'net1',
        expect.objectContaining({ nick: 'NewNick' }),
      );
      // NICK was sent on the live WebSocket connection
      expect(mockSendRaw).toHaveBeenCalledWith('net1', 'NICK NewNick');
      // currentNick was optimistically updated so the UI reflects the change
      // before the server echo arrives (same pattern as /nick)
      const liveNet = ircState.networks.find(n => n.networkId === 'net1');
      expect(liveNet?.currentNick).toBe('NewNick');
      // The persisted nick field is also updated so re-opening the form
      // shows the new value
      expect(liveNet?.nick).toBe('NewNick');
    });

    it('does not send NICK when nick is unchanged on save', async () => {
      const mockSendRaw = vi.fn();
      const network = createNetwork({ networkId: 'net1', name: 'TestNet', nick: 'SameNick', currentNick: 'SameNick' });
      ircState.networks.push(network);
      render(NetworkForm, {
        props: {
          mode: 'edit',
          networkId: 'net1',
          onClose: vi.fn(),
          onAddNetwork: mockAddNetwork,
          onUpdateNetwork: mockUpdateNetwork,
          onSendRaw: mockSendRaw,
        },
      });
      // Don't change the nick — just change something else (e.g. name)
      const nameInput = page.getByLabelText('Network name');
      await userEvent.clear(nameInput);
      await userEvent.type(nameInput, 'NewName');
      await userEvent.click(page.getByRole('button', { name: 'Save' }));

      expect(mockUpdateNetwork).toHaveBeenCalledWith(
        'net1',
        expect.objectContaining({ name: 'NewName' }),
      );
      // No NICK should be emitted because the nick didn't change
      expect(mockSendRaw).not.toHaveBeenCalled();
    });

    it('updates realName in local state on save (persisted across re-opens)', async () => {
      const network = createNetwork({ networkId: 'net1', name: 'TestNet', nick: 'MyNick', realName: 'Old Real Name' });
      ircState.networks.push(network);
      render(NetworkForm, {
        props: {
          mode: 'edit',
          networkId: 'net1',
          onClose: vi.fn(),
          onAddNetwork: mockAddNetwork,
          onUpdateNetwork: mockUpdateNetwork,
        },
      });
      const realNameInput = page.getByLabelText('Full name');
      await userEvent.clear(realNameInput);
      await userEvent.type(realNameInput, 'New Real Name');
      await userEvent.click(page.getByRole('button', { name: 'Save' }));

      const liveNet = ircState.networks.find(n => n.networkId === 'net1');
      expect(liveNet?.realName).toBe('New Real Name');
    });
  });
});
