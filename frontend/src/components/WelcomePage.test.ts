import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { tick } from 'svelte';
import WelcomePage from './WelcomePage.svelte';
import { ircState } from '../stores/ircStore.svelte';

vi.mock('/src/stores/wsConnection.svelte.ts', () => ({
  sendRaw: vi.fn(),
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
  disconnectNetwork: vi.fn(async () => undefined),
  editUpload: vi.fn(async () => undefined),
  fetchArchiveNames: vi.fn(async () => undefined),
  fetchBouncer: vi.fn(async () => undefined),
  fetchEgress: vi.fn(async () => undefined),
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

// The first-run page. It used to be a bare "Join a new network" form; a
// user whose signup-time provisioning was skipped (admin kill-switch,
// Mongo hiccup, pre-feature account) had no way to get the platform
// server. Now the page greets them and offers IRC Fiber in one click.
describe('WelcomePage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ircState.networks.length = 0;
    ircState.activeBuffer.networkId = null;
    ircState.activeBuffer.bufferName = null;
    ircState.me = { username: 'alice', email: 'alice@x.test' };
  });

  it('greets the user and prefills their nickname', async () => {
    render(WelcomePage, { props: {} });
    await tick();
    expect(document.body.innerText).toContain('Welcome to IRC Fiber, alice');
    const nick = document.querySelector('#addNetworkNick') as HTMLInputElement;
    expect(nick.value).toBe('alice');
  });

  it('connects to IRC Fiber in one click and adopts the network', async () => {
    render(WelcomePage, { props: {} });
    await tick();
    const btn = document.querySelector('.fiberCard__connect') as HTMLButtonElement;
    expect(btn).toBeTruthy();
    btn.click();
    await new Promise((r) => setTimeout(r, 60));
    expect(mockProvision).toHaveBeenCalled();
    expect(ircState.networks.map((n) => n.host)).toContain('irc.ircfiber.com');
    expect(ircState.activeBuffer.networkId).toBe('fiber-net-1');
  });

  it('surfaces a provisioning refusal instead of pretending', async () => {
    mockProvision.mockRejectedValueOnce(new Error('The IRC Fiber server is not available right now'));
    render(WelcomePage, { props: {} });
    await tick();
    (document.querySelector('.fiberCard__connect') as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 60));
    expect(document.body.innerText).toContain('The IRC Fiber server is not available right now');
    expect(ircState.networks.length).toBe(0);
  });
});
