import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page, userEvent } from 'vitest/browser';
import NetworkForm from './NetworkForm.svelte';
import { ircState } from '../stores/ircStore.svelte';
import { createNetwork } from '../test/factories';

/// `GET /api/egress` fixture: two slots (Berlin busy, Stockholm idle) and a
/// three-city catalog. Mutable so a test can simulate "every exit busy".
const egressMock = vi.hoisted(() => {
  const base = () => ({
    direct: 'direct',
    controllable: true,
    slotCount: 2,
    freeSlots: 1,
    slots: [
      { serverId: 'ovh1', label: 'de', host: 'mullvad-de', port: 1080, locationId: 'de-ber',
        hostname: 'de-ber-wg-003', country: 'Germany', countryCode: 'de', city: 'Berlin',
        controllable: true, state: 'ready', activeConns: 2, heldUntilMs: 0,
        exitIp: '1.2.3.4', healthy: true, checkedAtMs: 1, error: '' },
      { serverId: 'ovh1', label: 'se', host: 'mullvad-se', port: 1080, locationId: 'se-sto',
        hostname: 'se-sto-wg-201', country: 'Sweden', countryCode: 'se', city: 'Stockholm',
        controllable: true, state: 'ready', activeConns: 0, heldUntilMs: 0,
        exitIp: '5.6.7.8', healthy: true, checkedAtMs: 1, error: '' },
    ],
    locations: [
      { id: 'de-ber', country: 'Germany', countryCode: 'de', city: 'Berlin', relays: 2 },
      { id: 'se-sto', country: 'Sweden', countryCode: 'se', city: 'Stockholm', relays: 3 },
      { id: 'us-lax', country: 'USA', countryCode: 'us', city: 'Los Angeles', relays: 4 },
    ],
  });
  return { base, current: base() };
});

vi.mock('/src/stores/api', () => ({
  fetchEgress: vi.fn(async () => egressMock.current),
  addNetwork: vi.fn(async () => undefined),
  updateNetwork: vi.fn(async () => undefined),
  reconnectNetwork: vi.fn(async () => undefined),
  disconnectNetwork: vi.fn(async () => undefined),
  clearBacklog: vi.fn(async () => undefined),
  archiveChannel: vi.fn(async () => undefined),
  unarchiveChannel: vi.fn(async () => undefined),
  normalizeMessage: vi.fn((m: unknown) => m),
}));

describe('NetworkForm', () => {
  let mockAddNetwork: ReturnType<typeof vi.fn>;
  let mockUpdateNetwork: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    ircState.networks.length = 0;
    mockAddNetwork = vi.fn(async () => undefined);
    mockUpdateNetwork = vi.fn(async () => undefined);
    egressMock.current = egressMock.base();
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

  it('submits the chosen "Connect via" egress (direct) on add', async () => {
    render(NetworkForm, { props: { mode: 'add', networkId: null, onClose: vi.fn(), onAddNetwork: mockAddNetwork, onUpdateNetwork: mockUpdateNetwork } });
    await userEvent.type(page.getByLabelText('Network name'), 'BanNet');
    await userEvent.type(page.getByLabelText('Hostname'), 'irc.ban.net');
    await userEvent.type(page.getByLabelText('Nickname'), 'MyNick');
    await userEvent.selectOptions(page.getByLabelText(/Connect via/), 'direct');
    await userEvent.click(page.getByRole('button', { name: 'Join network' }));
    expect(mockAddNetwork).toHaveBeenCalledWith(expect.objectContaining({ egressNodeId: 'direct' }));
  });

  it('pre-fills and mirrors egressNodeId in edit mode', async () => {
    const network = createNetwork({ name: 'PinNet', host: 'irc.pin.net', nick: 'PinNick' });
    network.egressNodeId = 'direct';
    ircState.networks.push(network);
    render(NetworkForm, { props: { mode: 'edit', networkId: network.networkId, onClose: vi.fn(), onAddNetwork: mockAddNetwork, onUpdateNetwork: mockUpdateNetwork } });
    await expect.element(page.getByLabelText(/Connect via/)).toHaveValue('direct');
    await userEvent.selectOptions(page.getByLabelText(/Connect via/), '');
    await userEvent.click(page.getByRole('button', { name: 'Save' }));
    expect(mockUpdateNetwork).toHaveBeenCalledWith(network.networkId, expect.objectContaining({ egressNodeId: '' }));
    expect(ircState.networks[0].egressNodeId).toBe('');
  });

  it('submits a city location pin from the catalog on add', async () => {
    render(NetworkForm, { props: { mode: 'add', networkId: null, onClose: vi.fn(), onAddNetwork: mockAddNetwork, onUpdateNetwork: mockUpdateNetwork } });
    // The catalog arrives asynchronously; the option only exists once loaded.
    await expect.element(page.getByRole('option', { name: 'Los Angeles' })).toBeInTheDocument();
    await userEvent.type(page.getByLabelText('Network name'), 'CityNet');
    await userEvent.type(page.getByLabelText('Hostname'), 'irc.city.net');
    await userEvent.type(page.getByLabelText('Nickname'), 'MyNick');
    await userEvent.selectOptions(page.getByLabelText(/Connect via/), 'us-lax');
    await userEvent.click(page.getByRole('button', { name: 'Join network' }));
    expect(mockAddNetwork).toHaveBeenCalledWith(expect.objectContaining({ egressNodeId: 'us-lax' }));
  });

  it('offers a country pin for every catalogued country', async () => {
    render(NetworkForm, { props: { mode: 'add', networkId: null, onClose: vi.fn(), onAddNetwork: mockAddNetwork, onUpdateNetwork: mockUpdateNetwork } });
    await expect.element(page.getByRole('option', { name: 'Any city in Sweden' })).toBeInTheDocument();
    await userEvent.type(page.getByLabelText('Network name'), 'CountryNet');
    await userEvent.type(page.getByLabelText('Hostname'), 'irc.country.net');
    await userEvent.type(page.getByLabelText('Nickname'), 'MyNick');
    await userEvent.selectOptions(page.getByLabelText(/Connect via/), 'se');
    await userEvent.click(page.getByRole('button', { name: 'Join network' }));
    expect(mockAddNetwork).toHaveBeenCalledWith(expect.objectContaining({ egressNodeId: 'se' }));
  });

  it('lists running exits with their live connection counts', async () => {
    render(NetworkForm, { props: { mode: 'add', networkId: null, onClose: vi.fn(), onAddNetwork: mockAddNetwork, onUpdateNetwork: mockUpdateNetwork } });
    await expect.element(page.getByRole('option', { name: 'Berlin, Germany — 2 connections' })).toBeInTheDocument();
    await expect.element(page.getByRole('option', { name: 'Stockholm, Sweden — idle' })).toBeInTheDocument();
  });

  it('warns when every exit is in use', async () => {
    egressMock.current = { ...egressMock.base(), freeSlots: 0 };
    render(NetworkForm, { props: { mode: 'add', networkId: null, onClose: vi.fn(), onAddNetwork: mockAddNetwork, onUpdateNetwork: mockUpdateNetwork } });
    await expect.element(page.getByText(/All 2 exits are in use/)).toBeInTheDocument();
  });

  it('offers a static (non-retargetable) exit by its slot label', async () => {
    // Sidecars on another host: the engine cannot read their location, so the
    // picker addresses them by label and the SOCKS probe names the place.
    egressMock.current = {
      direct: 'direct',
      controllable: false,
      slotCount: 1,
      freeSlots: 0,
      slots: [
        { serverId: 'ovh', label: 'de', host: '100.94.116.56', port: 1080, locationId: '',
          hostname: '', country: 'Germany', countryCode: '', city: 'Berlin',
          controllable: false, state: 'ready', activeConns: 0, heldUntilMs: 0,
          exitIp: '151.241.171.103', healthy: true, checkedAtMs: 1, error: '' },
      ],
      locations: [],
    };
    render(NetworkForm, { props: { mode: 'add', networkId: null, onClose: vi.fn(), onAddNetwork: mockAddNetwork, onUpdateNetwork: mockUpdateNetwork } });
    await expect.element(page.getByRole('option', { name: 'Berlin, Germany — idle' })).toBeInTheDocument();
    await userEvent.type(page.getByLabelText('Network name'), 'StaticNet');
    await userEvent.type(page.getByLabelText('Hostname'), 'irc.static.net');
    await userEvent.type(page.getByLabelText('Nickname'), 'MyNick');
    await userEvent.selectOptions(page.getByLabelText(/Connect via/), 'de');
    await userEvent.click(page.getByRole('button', { name: 'Join network' }));
    expect(mockAddNetwork).toHaveBeenCalledWith(expect.objectContaining({ egressNodeId: 'de' }));
  });

  it('hides exit locations for the IRC Fiber server, which cannot be reached via an exit', async () => {
    render(NetworkForm, { props: { mode: 'add', networkId: null, onClose: vi.fn(), onAddNetwork: mockAddNetwork, onUpdateNetwork: mockUpdateNetwork } });
    // Locations are offered for a third-party host…
    await userEvent.type(page.getByLabelText('Hostname'), 'irc.other.net');
    await expect.element(page.getByRole('option', { name: 'Any city in Sweden' })).toBeInTheDocument();
    // …and disappear once the host is the first-party server.
    await userEvent.fill(page.getByLabelText('Hostname'), 'irc.ircfiber.com');
    await expect.element(page.getByText(/Exit locations don't apply to the IRC Fiber server/)).toBeInTheDocument();
    // `as HTMLSelectElement`: known DOM node, needed to read `.options`.
    const select = document.querySelector('#add-network-egress') as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).toEqual(['', 'direct']);
  });

  it('keeps a stranded location pin visible but disabled on the IRC Fiber server', async () => {
    const network = createNetwork({ name: 'Fiber', host: 'irc.ircfiber.com', nick: 'Me' });
    network.egressNodeId = 'se-sto';
    ircState.networks.push(network);
    render(NetworkForm, { props: { mode: 'edit', networkId: network.networkId, onClose: vi.fn(), onAddNetwork: mockAddNetwork, onUpdateNetwork: mockUpdateNetwork } });
    await expect.element(page.getByText(/The saved location/)).toBeInTheDocument();
    // `as HTMLOptionElement`: known DOM node, needed to read `.disabled`.
    const stranded = document.querySelector('#add-network-egress option[value="se-sto"]') as HTMLOptionElement;
    expect(stranded.textContent).toMatch(/not available for the IRC Fiber server/);
    expect(stranded.disabled).toBe(true);
    // The stored value is shown, not silently rewritten.
    await expect.element(page.getByLabelText(/Connect via/)).toHaveValue('se-sto');
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
