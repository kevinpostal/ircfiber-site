import { describe, expect, it, vi, beforeEach, afterEach, afterAll } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page, userEvent } from 'vitest/browser';
import { flushSync } from 'svelte';
import LoginPage from './LoginPage.svelte';
import App from '../App.svelte';
import MessageList from './MessageList.svelte';
import InputArea from './InputArea.svelte';
import SettingsPage from './SettingsPage.svelte';
import AddNetworkPage from './AddNetworkPage.svelte';
import { ircState } from '../stores/ircStore.svelte';
import { membersCollapsedMap } from '../stores/preferences.svelte';
import { createNetwork, createBuffer, createMember, createMessage, createNetworkWithChannels } from '../test/factories';
import { setViewport, restoreViewport, assertNoHorizontalOverflow, rectsDoNotOverlap, DESKTOP_VIEWPORT } from '../test/mobileViewport';
// Global styles are loaded by main.ts in the app, which tests bypass by
// rendering components directly. Mobile asserts need the real layout CSS
// (800px breakpoint, drawer mechanics, message grid), so import it here.
import '../app.css';
import '../styles/main.scss';

vi.mock('/src/stores/wsConnection.svelte.ts', () => ({
  connectWebSocket: vi.fn((onMessage, onOpen) => {
    onOpen?.();
    onMessage?.({ type: 'stat_user', username: 'tester', email: 'tester@test.local' });
    onMessage?.({ type: 'sync' });
  }),
  disconnectWebSocket: vi.fn(),
  sendRaw: vi.fn(),
  sendMessage: vi.fn(),
  sendEditMessage: vi.fn(),
  requestSync: vi.fn(),
  requestSwitchBuffer: vi.fn(),
  sendJson: vi.fn(),
  wsState: { value: 'disconnected' },
  maxEidTracker: { value: 0 },
  setMaxEid: vi.fn(),
  startXHRFallback: vi.fn(),
  stopXHRFallback: vi.fn(),
  waitForWsSessionId: vi.fn(async () => 'test-session'),
}));

vi.mock('/src/stores/api', () => ({
  fetchMe: vi.fn(async () => ({ username: 'tester', email: 'tester@test.local' })),
  fetchHealth: vi.fn(async () => ({ status: 'healthy', services: {} })),
  loadHistory: vi.fn(async () => []),
  loadHistoryWithMeta: vi.fn(async () => ({ messages: [], backlog_size: 0, earliest_msgid: '', earliest_ts: 0, earliest_eid: 0, cache_size: 0 })),
  reconnectNetwork: vi.fn(async () => undefined),
  clearBacklog: vi.fn(async () => undefined),
  disconnectNetwork: vi.fn(async () => undefined),
  joinChannel: vi.fn(async () => undefined),
  addNetwork: vi.fn(async () => undefined),
  provisionDefaultFiber: vi.fn(async () => undefined),
  updateNetwork: vi.fn(async () => undefined),
  fetchEgress: vi.fn(async () => ({ direct: 'direct', controllable: false, slotCount: 0, freeSlots: 0, slots: [], locations: [] })),
  deleteNetwork: vi.fn(async () => undefined),
  pinChannel: vi.fn(async () => undefined),
  unpinChannel: vi.fn(async () => undefined),
  updatePinnedOrder: vi.fn(async () => undefined),
  archiveChannel: vi.fn(async () => undefined),
  unarchiveChannel: vi.fn(async () => undefined),
  deletePastebin: vi.fn(async () => undefined),
  fetchPastebinsOffset: vi.fn(async () => ({ entries: [], total: 0 })),
  fetchPastebinById: vi.fn(async () => ({ id: 'x', name: 'test', syntax: 'text', lines: 1, body: 'hi', createdAt: Date.now(), buffer: '', networkId: '' })),
  pastebinUrl: vi.fn((id: string) => `/?/pastebin=${id}`),
  updatePastebin: vi.fn(async () => undefined),
  pastebinRawUrl: vi.fn((id: string) => `/pastebin/${id}/raw`),
  updateMembersCollapsed: vi.fn(async () => undefined),
  changePassword: vi.fn(async () => undefined),
  deleteAccount: vi.fn(async () => undefined),
  uploadAvatar: vi.fn(async () => undefined),
  removeAvatar: vi.fn(async () => undefined),
  fetchIrcAccount: vi.fn(async () => ({ status: 'none', account: '', password: '', reason: '' })),
  retryIrcAccount: vi.fn(async () => undefined),
  deleteUpload: vi.fn(async () => undefined),
  editUpload: vi.fn(async () => ({ status: 'ok' })),
  fetchUploadsOffset: vi.fn(async () => ({ uploads: [], total: 0 })),
  updateCollapsed: vi.fn(async () => undefined),
  updateInactiveCollapsed: vi.fn(async () => undefined),
  updateNetworkOrder: vi.fn(async () => undefined),
  updateBufferPrefs: vi.fn(async () => undefined),
  hideChannel: vi.fn(async () => undefined),
  unhideChannel: vi.fn(async () => undefined),
  createIrcArtSave: vi.fn(async () => undefined),
  updateIrcArtSave: vi.fn(async () => undefined),
  fetchIrcArtSave: vi.fn(async () => undefined),
  fetchIrcArtSavesOffset: vi.fn(async () => ({ entries: [], total: 0 })),
  deleteIrcArtSave: vi.fn(async () => undefined),
  fetchUploads: vi.fn(async () => []),
  fetchUploadById: vi.fn(async () => undefined),
  createPastebin: vi.fn(async () => undefined),
  fetchArchiveNames: vi.fn(async () => ({})),
  normalizeMessage: vi.fn((m: unknown) => m),
  fetchBouncer: vi.fn(async () => ({ enabled: true, host: 'bnc.test', port: 7000, tls: true, username: 'tester', password: null, networks: [], playbackLines: 200, playbackMax: 1000 })),
  generateBouncerPassword: vi.fn(async () => ({ enabled: true, host: 'bnc.test', port: 7000, tls: true, username: 'tester', password: 'token', networks: [], playbackLines: 200, playbackMax: 1000 })),
  revokeBouncerPassword: vi.fn(async () => undefined),
  fetchBouncerClients: vi.fn(async () => ({ clients: [], now: Date.now() })),
  disconnectBouncerClient: vi.fn(async () => undefined),
  updateBncPlaybackLines: vi.fn(async () => undefined),
  fetchLoginSessions: vi.fn(async () => ({ sessions: [], currentRef: '' })),
  revokeLoginSession: vi.fn(async () => ({ clientsDropped: 0 })),
  updateIgnores: vi.fn(async () => undefined),
  submitSupportIssue: vi.fn(async () => ({ id: 's1', number: 1 })),
  fetchMySupportIssues: vi.fn(async () => ({ issues: [], total: 0 })),
  fetchSupportIssue: vi.fn(async () => undefined),
  addSupportIssueComment: vi.fn(async () => undefined),
  convertUploadToGif: vi.fn(async () => ({})),
  startGifConversion: vi.fn(async () => 'job1'),
  getGifJob: vi.fn(async () => ({ state: 'done', percent: 100, frame: 0, fps: 0, speed: 0, durationMs: 0, outTimeMs: 0, elapsedMs: 0, etaMs: 0 })),
}));

import { fetchMe } from '/src/stores/api';

describe('mobile login', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
    // Unauthenticated: the /api/me probe 401s, so the login overlay owns the screen.
    vi.mocked(fetchMe).mockRejectedValueOnce(Object.assign(new Error('unauthorized'), { status: 401 }));
    globalThis.fetch = vi.fn(async () => new Response('{}', { status: 200 })) as typeof fetch;
    history.replaceState(null, '', '/');
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    history.replaceState(null, '', '/');
  });

  it('renders and fits at phone width', async () => {
    await setViewport(390, 844);
    render(LoginPage, { props: { onAuthenticated: vi.fn() } });

    const dialog = page.getByRole('dialog', { name: 'Sign in to IRC Fiber' });
    await expect.element(dialog).toBeInTheDocument();

    await userEvent.fill(page.getByLabelText('Username'), 'alice');
    await userEvent.fill(page.getByLabelText('Password'), 'Passw0rd!test');
    expect((page.getByLabelText('Username').element() as HTMLInputElement).value).toBe('alice');
    expect((page.getByLabelText('Password').element() as HTMLInputElement).value).toBe('Passw0rd!test');

    assertNoHorizontalOverflow();

    // Primary action must be a comfortable tap target (text-link buttons
    // like "Forgot password?" are inline links and exempt).
    const submit = page.getByRole('button', { name: 'Sign in', exact: true }).element() as HTMLElement;
    const rect = submit.getBoundingClientRect();
    expect(rect.width, `Sign in button width (got ${rect.width})`).toBeGreaterThanOrEqual(32);
    expect(rect.height, `Sign in button height (got ${rect.height})`).toBeGreaterThanOrEqual(32);

    await setViewport(DESKTOP_VIEWPORT.width, DESKTOP_VIEWPORT.height);
  }, 15000);
});

afterAll(async () => {
  await restoreViewport();
});


describe('mobile sidebar drawer', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
    globalThis.fetch = vi.fn(async (input: unknown) => {
      const url = typeof input === 'string' ? input : (input as Request).url;
      if (url.includes('/api/me')) {
        return new Response(JSON.stringify({ username: 'tester', email: 'tester@test.local' }), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    }) as typeof fetch;
    history.replaceState({}, '', '/');
    const net = createNetworkWithChannels(['#alpha', '#beta'], {
      networkId: 'net1',
      currentNick: 'tester',
      host: 'irc.test.local',
    });
    ircState.networks.push(net);
    ircState.activeBuffer.networkId = 'net1';
    ircState.activeBuffer.bufferName = '#alpha';
    flushSync();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    history.replaceState({}, '', '/');
  });

  it('opens, navigates, and closes at phone width; desktop unaffected', async () => {
    await setViewport(390, 844);
    render(App);
    await expect.element(page.getByRole('button', { name: 'Toggle sidebar' })).toBeInTheDocument();

    const wrap = () => document.querySelector('#wrap') as HTMLElement;
    const sidebarVisible = () => getComputedStyle(document.querySelector('#sidebar') as HTMLElement).visibility;

    // Open via the header hamburger.
    await userEvent.click(page.getByRole('button', { name: 'Toggle sidebar' }));
    await vi.waitFor(() => expect(wrap().classList.contains('sidebar-open')).toBe(true));
    // Visibility flips mid-transition (0.28s drawer slide), so poll it.
    await vi.waitFor(() => expect(sidebarVisible()).toBe('visible'));
    assertNoHorizontalOverflow();

    // Navigate from inside the drawer.
    await userEvent.click(document.querySelector('[data-buffer-key="net1:#beta"]') as HTMLElement);
    await vi.waitFor(() => expect(ircState.activeBuffer.bufferName).toBe('#beta'));

    // Reopen, then close via the backdrop. The open drawer (z-index 210)
    // sits above the backdrop (200), so a real cursor click at the
    // backdrop's center lands on the drawer; dispatch the bubbled click a
    // real tap on the exposed left strip would produce.
    await userEvent.click(page.getByRole('button', { name: 'Toggle sidebar' }));
    await vi.waitFor(() => expect(wrap().classList.contains('sidebar-open')).toBe(true));
    (document.querySelector('.drawer-backdrop') as HTMLElement).dispatchEvent(
      new MouseEvent('click', { bubbles: true, clientX: 20, clientY: 400 }),
    );
    await vi.waitFor(() => expect(wrap().classList.contains('sidebar-open')).toBe(false));
    // Reopen, then close via Escape.
    await userEvent.click(page.getByRole('button', { name: 'Toggle sidebar' }));
    await vi.waitFor(() => expect(wrap().classList.contains('sidebar-open')).toBe(true));
    await userEvent.keyboard('{Escape}');
    await vi.waitFor(() => expect(wrap().classList.contains('sidebar-open')).toBe(false));

    // Boundary: 800px is inclusive (drawer still opens).
    await setViewport(800, 800);
    await userEvent.click(page.getByRole('button', { name: 'Toggle sidebar' }));
    await vi.waitFor(() => expect(wrap().classList.contains('sidebar-open')).toBe(true));
    await userEvent.keyboard('{Escape}');
    await vi.waitFor(() => expect(wrap().classList.contains('sidebar-open')).toBe(false));

    // Desktop: the hamburger never applies the drawer class; the sidebar
    // stays statically visible (push behavior unchanged).
    await setViewport(801, 800);
    await userEvent.click(page.getByRole('button', { name: 'Toggle sidebar' }));
    await new Promise<void>((r) => requestAnimationFrame(() => r()));
    expect(wrap().classList.contains('sidebar-open')).toBe(false);
    expect(sidebarVisible()).toBe('visible');

    await setViewport(DESKTOP_VIEWPORT.width, DESKTOP_VIEWPORT.height);
  }, 15000);
});

describe('mobile chat + composer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ircState.optimisticMessages.clear();
    const net = createNetwork({ networkId: 'net1', currentNick: 'tester' });
    net.buffers.push(createBuffer({ name: '#chan' }));
    ircState.networks.push(net);
    ircState.activeBuffer.networkId = 'net1';
    ircState.activeBuffer.bufferName = '#chan';
    ircState.messages['net1:#chan'] = [
      createMessage({ nick: 'alice', text: 'hello there' }),
      createMessage({ nick: 'bob', text: 'how is it going?' }),
      createMessage({ nick: 'alice', text: 'x'.repeat(200) }),
    ];
    flushSync();
  });

  it('reads and sends on a phone viewport', async () => {
    await setViewport(360, 740);
    render(MessageList, { props: {} });
    render(InputArea, { props: {} });

    await expect.element(page.getByText('hello there')).toBeInTheDocument();
    await expect.element(page.getByText('how is it going?')).toBeInTheDocument();

    // Long unbroken string wraps instead of overflowing.
    assertNoHorizontalOverflow();

    // Grid timestamps own their column: no .date paints over its .message.
    // (Zero-area rects are display:none rows like status lines — skip.)
    for (const row of document.querySelectorAll('.row.messageRow')) {
      const date = row.querySelector('.date') as HTMLElement | null;
      const message = row.querySelector('.message') as HTMLElement | null;
      if (!date || !message) continue;
      const dr = date.getBoundingClientRect();
      const mr = message.getBoundingClientRect();
      if (dr.width === 0 || dr.height === 0 || mr.width === 0 || mr.height === 0) continue;
      expect(
        rectsDoNotOverlap(dr, mr),
        `timestamp overlaps message text in row: ${row.textContent?.slice(0, 60)}`,
      ).toBe(true);
    }

    // iOS no-zoom rule: composer text must stay >= 16px on phones (the
    // pill-composer overhaul later in _responsive.scss sets 17px).
    const textarea = page.getByRole('textbox', { name: /message input/i }).element() as HTMLElement;
    const composerPx = parseFloat(getComputedStyle(textarea).fontSize);
    expect(composerPx, `composer font-size (got ${composerPx}px)`).toBeGreaterThanOrEqual(16);
    // Send path: type + Enter lands an optimistic message in the list.
    await userEvent.type(page.getByRole('textbox', { name: /message input/i }), 'phone hello');
    await userEvent.keyboard('{Enter}');
    await expect.element(page.getByText('phone hello').first()).toBeInTheDocument({ timeout: 2000 });

    await setViewport(DESKTOP_VIEWPORT.width, DESKTOP_VIEWPORT.height);
  }, 15000);
});

describe('mobile members drawer', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
    globalThis.fetch = vi.fn(async () => new Response('{}', { status: 200 })) as typeof fetch;
    history.replaceState({}, '', '/');
    delete membersCollapsedMap['net1:#chan'];
    const net = createNetwork({ networkId: 'net1', currentNick: 'tester', host: 'irc.test.local' });
    net.buffers.push(
      createBuffer({ name: '#chan', isJoined: true, users: [createMember({ nick: 'alice' }), createMember({ nick: 'bob' })] }),
    );
    ircState.networks.push(net);
    ircState.activeBuffer.networkId = 'net1';
    ircState.activeBuffer.bufferName = '#chan';
    flushSync();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    history.replaceState({}, '', '/');
  });

  it('opens as a slide-over and closes; desktop toggles inline', async () => {
    await setViewport(390, 844);
    render(App);
    await expect.element(page.getByRole('button', { name: 'Members list' })).toBeInTheDocument();
    await vi.waitFor(() => expect(document.querySelector('#member-sidebar')).toBeInTheDocument());

    const wrap = () => document.querySelector('#wrap') as HTMLElement;
    const membersVisible = () =>
      getComputedStyle(document.querySelector('#member-sidebar') as HTMLElement).visibility;

    // Closed by default on phones: no slide-over class, panel hidden.
    expect(wrap().classList.contains('mobile-members-open')).toBe(false);

    // Open via the member-count button.
    await userEvent.click(page.getByRole('button', { name: 'Members list' }));
    await vi.waitFor(() => expect(wrap().classList.contains('mobile-members-open')).toBe(true));
    await vi.waitFor(() => expect(membersVisible()).toBe('visible'));
    assertNoHorizontalOverflow();

    // Close via the backdrop: the open slide-over covers the header toggle,
    // so a center-click on the toggle would land on the panel (same reason
    // the sidebar test dispatches the backdrop click synthetically).
    (document.querySelector('.drawer-backdrop') as HTMLElement).dispatchEvent(
      new MouseEvent('click', { bubbles: true, clientX: 20, clientY: 400 }),
    );
    await vi.waitFor(() => expect(wrap().classList.contains('mobile-members-open')).toBe(false));
    // Desktop control: the same button collapses the inline panel without
    // ever applying the mobile slide-over class.
    await setViewport(DESKTOP_VIEWPORT.width, DESKTOP_VIEWPORT.height);
    await userEvent.click(page.getByRole('button', { name: 'Members list' }));
    await vi.waitFor(() => expect(wrap().classList.contains('members-collapsed')).toBe(true));
    expect(wrap().classList.contains('mobile-members-open')).toBe(false);
    await userEvent.click(page.getByRole('button', { name: 'Members list' }));
    await vi.waitFor(() => expect(wrap().classList.contains('members-collapsed')).toBe(false));
    expect(wrap().classList.contains('mobile-members-open')).toBe(false);
  }, 15000);
});

describe('mobile settings + add-network', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
    globalThis.fetch = vi.fn(async () => new Response('{}', { status: 200 })) as typeof fetch;
    history.replaceState({}, '', '/');
    ircState.settingsTab = 'design';
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    history.replaceState({}, '', '/');
  });

  it('fits every settings tab at 360px', async () => {
    await setViewport(360, 740);
    render(SettingsPage);
    await expect.element(page.getByRole('tab', { name: 'Design' })).toBeInTheDocument();

    for (const tab of ['Design', 'Account', 'Notifications', 'Chat & embeds', 'Sessions', 'Bouncer']) {
      await userEvent.click(page.getByRole('tab', { name: tab }));
      await expect.element(page.getByRole('tab', { name: tab, selected: true })).toBeInTheDocument();
      assertNoHorizontalOverflow();
    }

    await setViewport(DESKTOP_VIEWPORT.width, DESKTOP_VIEWPORT.height);
  }, 15000);

  it('add-network form renders and accepts input at 360px', async () => {
    await setViewport(360, 740);
    render(AddNetworkPage, {
      props: { welcome: false, onSwitchBuffer: vi.fn(), onClose: vi.fn() },
    });

    await expect.element(page.getByLabelText('Network name')).toBeInTheDocument();
    await userEvent.fill(page.getByLabelText('Network name'), 'libera');
    await userEvent.fill(page.getByLabelText('Nickname'), 'tester');
    expect((page.getByLabelText('Network name').element() as HTMLInputElement).value).toBe('libera');
    expect((page.getByLabelText('Nickname').element() as HTMLInputElement).value).toBe('tester');
    assertNoHorizontalOverflow();

    await setViewport(DESKTOP_VIEWPORT.width, DESKTOP_VIEWPORT.height);
  }, 15000);
});