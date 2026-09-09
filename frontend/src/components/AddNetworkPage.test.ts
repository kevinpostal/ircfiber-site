import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { tick } from 'svelte';
import AddNetworkPage from './AddNetworkPage.svelte';
import { ircState } from '../stores/ircStore.svelte';
import type { Network } from '../types';

vi.mock('/src/stores/wsConnection.svelte.ts', () => ({
  sendRaw: vi.fn(),
  sendJson: vi.fn(),
  setMaxEid: vi.fn(),
}));

const { mockProvision, mockAdd } = vi.hoisted(() => ({
  mockProvision: vi.fn(async () => ({
    id: 'fiber-net-1', name: 'IRC Fiber', host: 'irc.ircfiber.com', port: 6697,
    tls: 'required', nick: 'alice', realName: 'alice', sasl: 'none',
  })),
  mockAdd: vi.fn(async () => ({})),
}));
vi.mock('/src/stores/api.ts', () => ({
  addNetwork: mockAdd,
  archiveChannel: vi.fn(async () => undefined),
  changePassword: vi.fn(async () => undefined),
  clearBacklog: vi.fn(async () => undefined),
  createIrcArtSave: vi.fn(async () => undefined),
  createPastebin: vi.fn(async () => undefined),
  deleteAccount: vi.fn(async () => undefined),
  deleteIrcArtSave: vi.fn(async () => undefined),
  deleteNetwork: vi.fn(async () => undefined),
  deletePastebin: vi.fn(async () => undefined),
  deleteUpload: vi.fn(async () => undefined),
  disconnectBouncerClient: vi.fn(async () => undefined),
  disconnectNetwork: vi.fn(async () => undefined),
  editUpload: vi.fn(async () => undefined),
  fetchArchiveNames: vi.fn(async () => undefined),
  fetchBouncer: vi.fn(async () => undefined),
  fetchBouncerClients: vi.fn(async () => ({ clients: [], now: Date.now() })),
  fetchEgress: vi.fn(async () => ({ direct: 'direct', controllable: false, slotCount: 0, freeSlots: 0, slots: [], locations: [] })),
  fetchHealth: vi.fn(async () => undefined),
  fetchIrcArtSave: vi.fn(async () => undefined),
  fetchIrcArtSavesOffset: vi.fn(async () => undefined),
  fetchMe: vi.fn(async () => undefined),
  fetchPastebinById: vi.fn(async () => undefined),
  fetchPastebinsOffset: vi.fn(async () => undefined),
  fetchUploadById: vi.fn(async () => undefined),
  fetchUploads: vi.fn(async () => undefined),
  fetchUploadsOffset: vi.fn(async () => undefined),
  generateBouncerPassword: vi.fn(async () => undefined),
  joinChannel: vi.fn(async () => undefined),
  loadHistory: vi.fn(async () => undefined),
  loadHistoryWithMeta: vi.fn(async () => undefined),
  normalizeMessage: vi.fn(async () => undefined),
  pastebinRawUrl: vi.fn(async () => undefined),
  pastebinUrl: vi.fn(async () => undefined),
  pinChannel: vi.fn(async () => undefined),
  provisionDefaultFiber: mockProvision,
  reconnectNetwork: vi.fn(async () => undefined),
  removeAvatar: vi.fn(async () => undefined),
  revokeBouncerPassword: vi.fn(async () => undefined),
  unarchiveChannel: vi.fn(async () => undefined),
  unpinChannel: vi.fn(async () => undefined),
  updateBncPlaybackLines: vi.fn(async () => undefined),
  updateBufferPrefs: vi.fn(async () => undefined),
  updateCollapsed: vi.fn(async () => undefined),
  updateInactiveCollapsed: vi.fn(async () => undefined),
  updateIrcArtSave: vi.fn(async () => undefined),
  updateMembersCollapsed: vi.fn(async () => undefined),
  updateNetwork: vi.fn(async () => undefined),
  updateNetworkOrder: vi.fn(async () => undefined),
  updateNotificationPrefs: vi.fn(async () => undefined),
  updatePastebin: vi.fn(async () => undefined),
  updatePinnedOrder: vi.fn(async () => undefined),
  uploadAvatar: vi.fn(async () => undefined),
}));

function fiberNetwork(): Network {
  return {
    networkId: 'fiber-net-1',
    name: 'IRC Fiber',
    host: 'irc.ircfiber.com',
    port: 6697,
    tls: 'required',
    nick: 'alice',
    realName: 'alice',
    currentNick: 'alice',
    sasl: 'none',
    saslUsername: '',
    saslPassword: '',
    systemManaged: true,
    connected: true,
    connecting: false,
    connectionState: 'connected',
    status: 'connected',
    disconnectReason: '',
    isAway: false,
    awayMessage: '',
    autoJoinChannels: ['#support', '#ircfiber'],
    autoJoinDelaySeconds: 0,
    egressNodeId: '',
    buffers: [{
      name: '_server', type: 'server' as const, isJoined: true,
      unseen: false, unseenCount: 0, unseenHighlights: [], isPinned: false, isArchived: false,
      topic: '', topicSetBy: '', topicSetAt: 0, users: [],
      lastSeenMsgTime: null, firstUnseenMsgIndex: null,
      lastSeen: null, bottomSeen: null, clearedAt: null, modeFlags: {},
    }],
    awayNicks: new Set(),
    capabilities: new Set(),
    isupport: {},
    chanTypes: '#',
    egressLabel: null,
    egressHost: null,
    egressIp: null,
    egressLocation: null,
    lagMs: null,
    connectedAtMs: null,
    tlsInfo: null,
  } as unknown as Network;
}

// The post-signup landing page and the "Add a network" surface are the same
// component: sidebar on the left (App's shell), this page in `.main-area`.
// Signup provisions the IRC Fiber network before the redirect, so the welcome
// variant offers its channels as chips; the one-click Fiber card is only the
// recovery path for an account whose provisioning was skipped (admin
// kill-switch, no healthy engine, pre-feature account).
describe('AddNetworkPage', () => {
  const props = () => ({ welcome: true, onSwitchBuffer: vi.fn(), onClose: vi.fn() });

  beforeEach(() => {
    vi.clearAllMocks();
    ircState.networks.length = 0;
    ircState.activeBuffer.networkId = null;
    ircState.activeBuffer.bufferName = null;
    ircState.me = { username: 'alice', email: 'alice@x.test' };
  });

  it('greets the user and prefills their nickname', async () => {
    render(AddNetworkPage, { props: props() });
    await tick();
    expect(document.body.innerText).toContain('Welcome to IRC Fiber, alice');
    const nick = document.querySelector('#add-network-nick') as HTMLInputElement;
    expect(nick.value).toBe('alice');
  });

  it('offers the Fiber channels as chips and switches to the clicked one', async () => {
    ircState.networks.push(fiberNetwork());
    const p = props();
    render(AddNetworkPage, { props: p });
    await tick();
    const chips = Array.from(document.querySelectorAll('[data-testid="fiber-channels"] button'));
    expect(chips.map((c) => c.textContent?.trim())).toEqual(['#support', '#ircfiber']);
    (chips.find((c) => c.textContent?.trim() === '#support') as HTMLButtonElement).click();
    expect(p.onSwitchBuffer).toHaveBeenCalledWith('fiber-net-1', '#support');
  });

  it('hides the one-click Fiber card once the network exists', async () => {
    ircState.networks.push(fiberNetwork());
    render(AddNetworkPage, { props: props() });
    await tick();
    expect(document.querySelector('[data-testid="fiber-card"]')).toBeNull();
  });

  it('connects to IRC Fiber in one click and adopts the network', async () => {
    render(AddNetworkPage, { props: props() });
    await tick();
    const btn = document.querySelector('.fiberCard__connect') as HTMLButtonElement;
    expect(btn).toBeTruthy();
    btn.click();
    await vi.waitFor(() => expect(mockProvision).toHaveBeenCalled());
    await vi.waitFor(() => expect(ircState.activeBuffer.networkId).toBe('fiber-net-1'));
    expect(ircState.networks.map((n) => n.host)).toContain('irc.ircfiber.com');
  });

  it('surfaces a provisioning refusal instead of pretending', async () => {
    mockProvision.mockRejectedValueOnce(new Error('The IRC Fiber server is not available right now'));
    render(AddNetworkPage, { props: props() });
    await tick();
    (document.querySelector('.fiberCard__connect') as HTMLButtonElement).click();
    await vi.waitFor(() =>
      expect(document.body.innerText).toContain('The IRC Fiber server is not available right now'));
    expect(ircState.networks.length).toBe(0);
  });
});
