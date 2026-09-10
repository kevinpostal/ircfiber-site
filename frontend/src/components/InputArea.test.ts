import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page, userEvent } from 'vitest/browser';
import { flushSync } from 'svelte';
import InputArea from './InputArea.svelte';
import { createNetwork, createBuffer, createMember, createMessage } from '../test/factories';
import { ircState, updateChannelUsers, recordSentMessage, lastSentMessages, bufferInputText, setTyping, clearTyping } from '../stores/ircStore.svelte';
import { globalPrefs, DEFAULT_PREFS } from '../stores/preferences.svelte';
import { recentHighlightersCache } from '../lib/tabCompletion';
import { bufferNameFromChannelPart } from '../lib/routing';
import { DEFAULT_COMPOSE_STYLE } from '../lib/composeStyle';

vi.mock('/src/stores/api', () => ({
  // uploadFlow imports these; a factory mock must name every export the
  // module graph pulls in or the whole suite fails to collect.
  convertUploadToGif: vi.fn(async () => ({ id: 'gif1', url: '/uploads/x.gif' })),
  startGifConversion: vi.fn(async () => 'job1'),
  getGifJob: vi.fn(async () => ({ state: 'done', percent: 100, frame: 0, fps: 0, speed: 0, durationMs: 0, outTimeMs: 0, elapsedMs: 0, etaMs: 0 })),
  reconnectNetwork: vi.fn(async () => undefined),
  clearBacklog: vi.fn(async () => undefined),
  disconnectNetwork: vi.fn(async () => undefined),
  fetchMe: vi.fn(async () => ({ username: 'tester', email: 'tester@test.local' })),
  fetchHealth: vi.fn(async () => ({ status: 'healthy', services: {} })),
  loadHistory: vi.fn(async () => []),
  joinChannel: vi.fn(async () => undefined),
  addNetwork: vi.fn(async () => undefined),
  updateNetwork: vi.fn(async () => undefined),
  deleteNetwork: vi.fn(async () => undefined),
  archiveChannel: vi.fn(async () => undefined),
  unarchiveChannel: vi.fn(async () => undefined),
  // ircStore imports this for the WebSocket-sync message normalization
  // path (sync payloads carry the engine's wire-format compact JSON keys,
  // so we have to translate them into the IRCMessage shape). The tests in
  // this file don't exercise that path, so pass-through is fine.
  normalizeMessage: vi.fn((m: unknown) => m),
}));

import { reconnectNetwork } from '../stores/api';

function resetState(): void {
	ircState.networks.length = 0;
	ircState.activeBuffer.networkId = null;
	ircState.activeBuffer.bufferName = null;
	ircState.messages = {};
	ircState.processedMessages = {};
	bufferInputText.clear();
	// Clear lastSentMessages from previous tests
	for (const k of Object.keys(lastSentMessages)) delete lastSentMessages[k];
	// Reset feature flags to defaults
	Object.assign(globalPrefs, DEFAULT_PREFS);
	// Clear recent highlighters cache
	recentHighlightersCache.clear();
}

beforeEach(() => {
	resetState();
	vi.clearAllMocks();
});

describe('InputArea', () => {
	let mockSendMessage: ReturnType<typeof vi.fn>;
	let mockSendRaw: ReturnType<typeof vi.fn>;
	let mockSendEditMessage: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		mockSendMessage = vi.fn();
		mockSendRaw = vi.fn();
		mockSendEditMessage = vi.fn();
	});

	it('renders textarea', async () => {
		render(InputArea, { props: { onSendMessage: mockSendMessage, onSendRaw: mockSendRaw } });

		await expect.element(page.getByRole('textbox', { name: /message input/i })).toBeInTheDocument();
	});

	it('sends message on Enter', async () => {
		const net = createNetwork({ networkId: 'net1', currentNick: 'tester' });
		net.buffers.push(createBuffer({ name: '#general' }));
		ircState.networks.push(net);
		ircState.activeBuffer.networkId = 'net1';
		ircState.activeBuffer.bufferName = '#general';
		flushSync();

		render(InputArea, { props: { onSendMessage: mockSendMessage, onSendRaw: mockSendRaw } });

		const textarea = page.getByRole('textbox', { name: /message input/i });
		await userEvent.type(textarea, 'hello world');
		await userEvent.keyboard('{Enter}');

		expect(mockSendMessage).toHaveBeenCalledWith('net1', '#general', 'hello world', expect.any(String));
	});

	it('handles slash commands (/join, /nick)', async () => {
		const net = createNetwork({ networkId: 'net1', currentNick: 'tester' });
		net.buffers.push(createBuffer({ name: '#general' }));
		ircState.networks.push(net);
		ircState.activeBuffer.networkId = 'net1';
		ircState.activeBuffer.bufferName = '#general';
		flushSync();

		render(InputArea, { props: { onSendMessage: mockSendMessage, onSendRaw: mockSendRaw } });

		const textarea = page.getByRole('textbox', { name: /message input/i });
		await userEvent.type(textarea, '/join #test');
		await userEvent.keyboard('{Enter}');

		expect(mockSendRaw).toHaveBeenCalledWith('net1', 'JOIN #test');
	});

	it('shows current nick avatar', async () => {
		const net = createNetwork({ networkId: 'net1', currentNick: 'tester' });
		net.buffers.push(createBuffer({ name: '#general' }));
		ircState.networks.push(net);
		ircState.activeBuffer.networkId = 'net1';
		ircState.activeBuffer.bufferName = '#general';
		flushSync();

		render(InputArea, { props: { onSendMessage: mockSendMessage, onSendRaw: mockSendRaw } });

		await expect.element(page.getByText('tester')).toBeInTheDocument();
		expect(document.querySelector('#input-avatar')).toBeInTheDocument();
	});

	it('updates the displayed nick when currentNick changes (realtime)', async () => {
		const net = createNetwork({ networkId: 'net1', currentNick: 'oldnick' });
		net.buffers.push(createBuffer({ name: '#general' }));
		ircState.networks.push(net);
		ircState.activeBuffer.networkId = 'net1';
		ircState.activeBuffer.bufferName = '#general';
		flushSync();

		render(InputArea, { props: { onSendMessage: mockSendMessage, onSendRaw: mockSendRaw } });

		// Initial nick is shown
		await expect.element(page.getByText('oldnick')).toBeInTheDocument();
		expect(document.querySelector('#input-avatar')?.textContent?.trim()).toBe('O');

		// Simulate NICK response from server updating the network's currentNick
		const liveNet = ircState.networks.find(n => n.networkId === 'net1');
		expect(liveNet).toBeDefined();
		liveNet!.currentNick = 'newbie';
		flushSync();

		// UI should now reflect the new nick
		await expect.element(page.getByText('newbie')).toBeInTheDocument();
		await expect.element(page.getByText('oldnick')).not.toBeInTheDocument();
		expect(document.querySelector('#input-avatar')?.textContent?.trim()).toBe('N');
	});

	it('updates displayed nick via updateChannelUsers (NICK event)', async () => {
		const net = createNetwork({ networkId: 'net1', currentNick: 'joebob' });
		net.buffers.push(createBuffer({ name: '#general' }));
		ircState.networks.push(net);
		ircState.activeBuffer.networkId = 'net1';
		ircState.activeBuffer.bufferName = '#general';
		flushSync();

		render(InputArea, { props: { onSendMessage: mockSendMessage, onSendRaw: mockSendRaw } });

		await expect.element(page.getByText('joebob')).toBeInTheDocument();

		// Simulate NICK event from server via updateChannelUsers
		updateChannelUsers('net1', '#general', 'NICK', 'joebob', ['joebob', 'superman']);
		flushSync();

		await expect.element(page.getByText('superman')).toBeInTheDocument();
		await expect.element(page.getByText('joebob')).not.toBeInTheDocument();
		expect(document.querySelector('#input-avatar')?.textContent?.trim()).toBe('S');
	});

	it('handles tab completion', async () => {
		const net = createNetwork({ networkId: 'net1', currentNick: 'tester' });
		net.buffers.push(
			createBuffer({ name: '#general', users: [createMember({ nick: 'alice' }), createMember({ nick: 'alex' })] }),
		);
		ircState.networks.push(net);
		ircState.activeBuffer.networkId = 'net1';
		ircState.activeBuffer.bufferName = '#general';
		flushSync();

		render(InputArea, { props: { onSendMessage: mockSendMessage, onSendRaw: mockSendRaw } });

		const textarea = page.getByRole('textbox', { name: /message input/i });
		await userEvent.type(textarea, 'al');
		await userEvent.keyboard('{Tab}');

		const value = (textarea.element() as HTMLTextAreaElement).value;
		expect(value).toMatch(/alice|alex/);
	});

	it('Tabs through recent highlighters on empty input in channel', async () => {
		const net = createNetwork({ networkId: 'net1', currentNick: 'tester' });
		net.buffers.push(createBuffer({ name: '#general', users: [createMember({ nick: 'alice' }), createMember({ nick: 'bob' })] }));
		ircState.networks.push(net);
		ircState.activeBuffer.networkId = 'net1';
		ircState.activeBuffer.bufferName = '#general';
		flushSync();

		// Seed recent highlighters (most recent first)
		recentHighlightersCache.set('net1:#general', ['bob', 'alice']);

		render(InputArea, { props: { onSendMessage: mockSendMessage, onSendRaw: mockSendRaw } });

		const textarea = page.getByRole('textbox', { name: /message input/i });
		const el = textarea.element() as HTMLTextAreaElement;
		expect(el.value).toBe('');

		// First Tab → most recent highlighter (bob)
		await userEvent.keyboard('{Tab}');
		expect(el.value).toBe('bob: ');

		// Second Tab → second most recent (alice)
		await userEvent.keyboard('{Tab}');
		expect(el.value).toBe('alice: ');

		// Third Tab → wraps back to bob
		await userEvent.keyboard('{Tab}');
		expect(el.value).toBe('bob: ');
	});

	it('Shift+Tab cycles backward through recent highlighters', async () => {
		const net = createNetwork({ networkId: 'net1', currentNick: 'tester' });
		net.buffers.push(createBuffer({ name: '#general' }));
		ircState.networks.push(net);
		ircState.activeBuffer.networkId = 'net1';
		ircState.activeBuffer.bufferName = '#general';
		flushSync();

		recentHighlightersCache.set('net1:#general', ['alice', 'bob', 'charlie']);

		render(InputArea, { props: { onSendMessage: mockSendMessage, onSendRaw: mockSendRaw } });

		const textarea = page.getByRole('textbox', { name: /message input/i });
		const el = textarea.element() as HTMLTextAreaElement;

		// Shift+Tab → last entry (charlie)
		await userEvent.keyboard('{Shift>}{Tab}{/Shift}');
		expect(el.value).toBe('charlie: ');
	});

	it('does NOT cycle highlighters with non-empty input — uses existing members', async () => {
		const net = createNetwork({ networkId: 'net1', currentNick: 'tester' });
		net.buffers.push(
			createBuffer({ name: '#general', users: [createMember({ nick: 'alice' }), createMember({ nick: 'bob' })] }),
		);
		ircState.networks.push(net);
		ircState.activeBuffer.networkId = 'net1';
		ircState.activeBuffer.bufferName = '#general';
		flushSync();

		// Seed highlighters — should be ignored for non-empty input
		recentHighlightersCache.set('net1:#general', ['zorro']);

		render(InputArea, { props: { onSendMessage: mockSendMessage, onSendRaw: mockSendRaw } });

		const textarea = page.getByRole('textbox', { name: /message input/i });
		const el = textarea.element() as HTMLTextAreaElement;

		// Type 'al' then Tab — should use existing member completion, not highlighters
		await userEvent.type(textarea, 'al');
		await userEvent.keyboard('{Tab}');

		expect(el.value).toMatch(/alice/);
		expect(el.value).not.toBe('zorro: ');
	});

	it('does NOT cycle highlighters in server buffer', async () => {
		const net = createNetwork({ networkId: 'net1', currentNick: 'tester' });
		net.buffers.push(createBuffer({ name: '_server', type: 'server' }));
		ircState.networks.push(net);
		ircState.activeBuffer.networkId = 'net1';
		ircState.activeBuffer.bufferName = '_server';
		flushSync();

		recentHighlightersCache.set('net1:_server', ['alice']);

		render(InputArea, { props: { onSendMessage: mockSendMessage, onSendRaw: mockSendRaw } });

		const textarea = page.getByRole('textbox', { name: /message input/i });
		const el = textarea.element() as HTMLTextAreaElement;

		// Tab on empty input in server buffer should do nothing
		await userEvent.keyboard('{Tab}');
		expect(el.value).toBe('');
	});

	it('resets highlight cycle index when user starts typing', async () => {
		const net = createNetwork({ networkId: 'net1', currentNick: 'tester' });
		net.buffers.push(createBuffer({ name: '#general' }));
		ircState.networks.push(net);
		ircState.activeBuffer.networkId = 'net1';
		ircState.activeBuffer.bufferName = '#general';
		flushSync();

		recentHighlightersCache.set('net1:#general', ['alice', 'bob', 'charlie']);

		render(InputArea, { props: { onSendMessage: mockSendMessage, onSendRaw: mockSendRaw } });

		const textarea = page.getByRole('textbox', { name: /message input/i });
		const el = textarea.element() as HTMLTextAreaElement;

		// Tab to first highlighter
		await userEvent.keyboard('{Tab}');
		expect(el.value).toBe('alice: ');

		// Type something (non-Tab key) → resets cycle
		await userEvent.keyboard('{Backspace}');
		await userEvent.keyboard('{Backspace}');
		// Wait — the input is empty again after backspacing "alice: "
		await userEvent.clear(el);
		flushSync();

		// Tab again — should start from alice again (cycle reset)
		await userEvent.keyboard('{Tab}');
		expect(el.value).toBe('alice: ');
	});

	it('starting typing then clearing and tabbing resets highlight cycle', async () => {
		const net = createNetwork({ networkId: 'net1', currentNick: 'tester' });
		net.buffers.push(createBuffer({ name: '#general' }));
		ircState.networks.push(net);
		ircState.activeBuffer.networkId = 'net1';
		ircState.activeBuffer.bufferName = '#general';
		flushSync();

		recentHighlightersCache.set('net1:#general', ['alice', 'bob']);

		render(InputArea, { props: { onSendMessage: mockSendMessage, onSendRaw: mockSendRaw } });

		const textarea = page.getByRole('textbox', { name: /message input/i });
		const el = textarea.element() as HTMLTextAreaElement;

		// First Tab → alice
		await userEvent.keyboard('{Tab}');
		expect(el.value).toBe('alice: ');

		// Second Tab → bob
		await userEvent.keyboard('{Tab}');
		expect(el.value).toBe('bob: ');

		// Type something then clear
		await userEvent.type(textarea, 'hello');
		await userEvent.clear(el);
		flushSync();

		// Tab should start from alice again (reset)
		await userEvent.keyboard('{Tab}');
		expect(el.value).toBe('alice: ');
	});

	it('auto-connects then joins channel on /join when disconnected', async () => {
		const net = createNetwork({ networkId: 'net1', name: 'TestNet', connected: false, connectionState: 'disconnected' });
		net.buffers.push(createBuffer({ name: '#general' }));
		ircState.networks.push(net);
		ircState.activeBuffer.networkId = 'net1';
		ircState.activeBuffer.bufferName = '#general';
		flushSync();

		render(InputArea, { props: { onSendMessage: mockSendMessage, onSendRaw: mockSendRaw } });

		const textarea = page.getByRole('textbox', { name: /message input/i });
		await userEvent.type(textarea, '/join #test');
		await userEvent.keyboard('{Enter}');

		expect(reconnectNetwork).toHaveBeenCalledWith('net1');

		expect(mockSendRaw).toHaveBeenCalledWith('net1', 'JOIN #test');

		expect(ircState.activeBuffer.networkId).toBe('net1');
		expect(ircState.activeBuffer.bufferName).toBe('#test');

		// Verify channel buffer was created optimistically in the sidebar.
		// isJoined starts false (our fix — see App.test.ts 'hides member sidebar
		// after join is rejected and redirected') and flips to true only when
		// the IRC server confirms the JOIN with our own JOIN event.
		const testBuf = ircState.networks
			.find(n => n.networkId === 'net1')
			?.buffers.find(b => b.name === '#test');
		expect(testBuf).toBeDefined();
		expect(testBuf?.type).toBe('channel');
		expect(testBuf?.isJoined).toBe(false);

		// Optimistic transition only: the store shows `connecting` and leaves
		// `connected` false — claiming connected here used to hide the banner,
		// show a bogus uptime and block every later sync correction until a
		// DISCONNECT event arrived. Only 001 flips `connected`.
		const updatedNet = ircState.networks.find(n => n.networkId === 'net1');
		expect(updatedNet?.connected).toBe(false);
		expect(updatedNet?.connectionState).toBe('connecting');

		// The router percent-encodes the full buffer name (`#test` → `%23test`)
		// so the URL → buffer round-trip is lossless for `##test`/`&foo` too
		// (see lib/routing.ts channelUrlPart + App.svelte's decodeURIComponent
		// of the `/channel/<part>` segment).
		expect(window.location.pathname).toBe('/irc/TestNet/channel/%23test');
		const part = window.location.pathname.split('/channel/')[1];
		expect(bufferNameFromChannelPart(decodeURIComponent(part))).toBe('#test');
	});

	it('opens the emoji picker popover when the emoji button is clicked', async () => {
		const net = createNetwork({ networkId: 'net1', currentNick: 'tester' });
		net.buffers.push(createBuffer({ name: '#general' }));
		ircState.networks.push(net);
		ircState.activeBuffer.networkId = 'net1';
		ircState.activeBuffer.bufferName = '#general';
		flushSync();

		render(InputArea, { props: { onSendMessage: mockSendMessage, onSendRaw: mockSendRaw } });

		// Initially no popover
		expect(document.getElementById('emoji-popover')).toBeNull();

		// Use a direct dispatchEvent since vitest-browser reports the element
		// as "not visible" in headless rendering (no layout dimensions).
		const emojiBtn = document.querySelector('.emojicell') as HTMLElement;
		expect(emojiBtn).toBeTruthy();
		emojiBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
		await Promise.resolve();
		await Promise.resolve();

		// Popover should now exist
		const popover = document.getElementById('emoji-popover');
		expect(popover).toBeInTheDocument();
		expect(popover?.querySelector('emoji-picker')).toBeTruthy();

		// Clicking again should close it
		emojiBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
		await Promise.resolve();
		expect(document.getElementById('emoji-popover')).toBeNull();
	});

	it('adds optimistic message to processedMessages so it renders immediately', async () => {
		const net = createNetwork({ networkId: 'net1', currentNick: 'tester' });
		net.buffers.push(createBuffer({ name: '#general' }));
		ircState.networks.push(net);
		ircState.activeBuffer.networkId = 'net1';
		ircState.activeBuffer.bufferName = '#general';
		// Simulate existing messages loaded from cache/history with a warm processed cache.
		ircState.messages['net1:#general'] = [createMessage({ text: 'existing', t: Date.now() - 1000 })];
		ircState.processedMessages['net1:#general'] = [createMessage({ text: 'existing', t: Date.now() - 1000 })];
		flushSync();

		render(InputArea, { props: { onSendMessage: mockSendMessage, onSendRaw: mockSendRaw } });

		const textarea = page.getByRole('textbox', { name: /message input/i });
		await userEvent.type(textarea, 'hello world');
		await userEvent.keyboard('{Enter}');

		expect(mockSendMessage).toHaveBeenCalledWith('net1', '#general', 'hello world', expect.any(String));

		const processed = ircState.processedMessages['net1:#general'];
		expect(processed).toHaveLength(2);
		expect(processed![1].text).toBe('hello world');
		expect(processed![1].nick).toBe('tester');
		expect(processed![1].label).toBeDefined();
	});

	// ── Edit message (Ctrl/Cmd+Up) ──

	it('Ctrl+Cmd+Up does nothing when editMessage flag is disabled (default)', async () => {
		const net = createNetwork({ networkId: 'net1', currentNick: 'tester' });
		net.buffers.push(createBuffer({ name: '#general' }));
		ircState.networks.push(net);
		ircState.activeBuffer.networkId = 'net1';
		ircState.activeBuffer.bufferName = '#general';
		flushSync();

		render(InputArea, { props: { onSendMessage: mockSendMessage, onSendRaw: mockSendRaw } });
		const textarea = page.getByRole('textbox', { name: /message input/i });
		const el = textarea.element() as HTMLTextAreaElement;
		expect(el.value).toBe('');

		// Ctrl+Meta+Up (Cmd+Up on Mac)
		await userEvent.keyboard('{Control>}{Meta>}{ArrowUp}{/Meta}{/Control}');
		flushSync();

		// Should NOT change value since editMessage flag is disabled
		expect(el.value).toBe('');
	});

	it('Ctrl+ArrowUp (without Meta) on empty input with last sent prefills [edit] body', async () => {
		globalPrefs.featureFlags.editMessage.enabled = true;
		const net = createNetwork({ networkId: 'net1', currentNick: 'tester' });
		net.buffers.push(createBuffer({ name: '#general' }));
		ircState.networks.push(net);
		ircState.activeBuffer.networkId = 'net1';
		ircState.activeBuffer.bufferName = '#general';
		recordSentMessage('net1', '#general', { label: 'abc', body: 'hello world' });
		flushSync();

		render(InputArea, { props: { onSendMessage: mockSendMessage, onSendRaw: mockSendRaw, onSendEditMessage: mockSendEditMessage } });
		const textarea = page.getByRole('textbox', { name: /message input/i });
		const el = textarea.element() as HTMLTextAreaElement;

		// Ctrl+ArrowUp only (Linux/Windows style)
		await userEvent.keyboard('{Control>}{ArrowUp}{/Control}');
		flushSync();

		expect(el.value).toBe('[edit] hello world');
	});

	it('Ctrl+Cmd+Up with non-empty input does nothing', async () => {
		globalPrefs.featureFlags.editMessage.enabled = true;
		const net = createNetwork({ networkId: 'net1', currentNick: 'tester' });
		net.buffers.push(createBuffer({ name: '#general' }));
		ircState.networks.push(net);
		ircState.activeBuffer.networkId = 'net1';
		ircState.activeBuffer.bufferName = '#general';
		recordSentMessage('net1', '#general', { label: 'abc', body: 'hello world' });
		flushSync();

		render(InputArea, { props: { onSendMessage: mockSendMessage, onSendRaw: mockSendRaw, onSendEditMessage: mockSendEditMessage } });
		const textarea = page.getByRole('textbox', { name: /message input/i });
		const el = textarea.element() as HTMLTextAreaElement;

		await userEvent.type(textarea, 'already typing');
		const currentVal = el.value;
		expect(currentVal).toBe('already typing');

		// Ctrl+Cmd+Up should be ignored when input is non-empty
		await userEvent.keyboard('{Control>}{Meta>}{ArrowUp}{/Meta}{/Control}');
		flushSync();

		expect(el.value).toBe('already typing');
	});

	it('sends edit message via onSendEditMessage with original label and strips [edit] prefix', async () => {
		globalPrefs.featureFlags.editMessage.enabled = true;
		const net = createNetwork({ networkId: 'net1', currentNick: 'tester' });
		net.buffers.push(createBuffer({ name: '#general' }));
		ircState.networks.push(net);
		ircState.activeBuffer.networkId = 'net1';
		ircState.activeBuffer.bufferName = '#general';
		recordSentMessage('net1', '#general', { label: 'origLabel', body: 'original text' });
		flushSync();

		render(InputArea, { props: { onSendMessage: mockSendMessage, onSendRaw: mockSendRaw, onSendEditMessage: mockSendEditMessage } });
		const textarea = page.getByRole('textbox', { name: /message input/i });
		const el = textarea.element() as HTMLTextAreaElement;

		// Trigger edit mode
		await userEvent.keyboard('{Control>}{Meta>}{ArrowUp}{/Meta}{/Control}');
		flushSync();
		expect(el.value).toBe('[edit] original text');

		// Modify the text (append " edited")
		await userEvent.keyboard(' edited');
		flushSync();
		expect(el.value).toBe('[edit] original text edited');

		// Send the edit
		await userEvent.keyboard('{Enter}');
		flushSync();

		// Should call onSendEditMessage with stripped [edit] prefix and original label
		expect(mockSendEditMessage).toHaveBeenCalledWith('net1', '#general', 'original text edited', 'origLabel');
		expect(el.value).toBe('');
	});

	it('clears editTarget after sending edit message', async () => {
		globalPrefs.featureFlags.editMessage.enabled = true;
		const net = createNetwork({ networkId: 'net1', currentNick: 'tester' });
		net.buffers.push(createBuffer({ name: '#general' }));
		ircState.networks.push(net);
		ircState.activeBuffer.networkId = 'net1';
		ircState.activeBuffer.bufferName = '#general';
		recordSentMessage('net1', '#general', { label: 'abc', body: 'first message' });
		flushSync();

		render(InputArea, { props: { onSendMessage: mockSendMessage, onSendRaw: mockSendRaw, onSendEditMessage: mockSendEditMessage } });
		const textarea = page.getByRole('textbox', { name: /message input/i });
		const el = textarea.element() as HTMLTextAreaElement;

		// Enter edit mode and send
		await userEvent.keyboard('{Control>}{Meta>}{ArrowUp}{/Meta}{/Control}');
		flushSync();
		await userEvent.keyboard('{Enter}');
		flushSync();

		// After sending, input is cleared
		expect(el.value).toBe('');

		// Ctrl+Cmd+Up again should NOT prefill (no editTarget, and lastSent was not
		// updated because edit path didn't generate a new label via recordSentMessage
		// in this test — but actually it does call recordSentMessage)
	});

	it('lastSentMessageForBuffer returns null when no message sent to the buffer', async () => {
		const { lastSentMessageForBuffer } = await import('../stores/ircStore.svelte');
		const net = createNetwork({ networkId: 'net1', currentNick: 'tester' });
		net.buffers.push(createBuffer({ name: '#general' }));
		ircState.networks.push(net);
		ircState.activeBuffer.networkId = 'net1';
		ircState.activeBuffer.bufferName = '#general';
		flushSync();

		// No last sent message for this buffer
		const result = lastSentMessageForBuffer(ircState.activeBuffer);
		expect(result).toBeNull();
	});

	it('hides the typing indicator immediately when clearTyping fires (done TAGMSG), without waiting for a tick', async () => {
		// Regression: clearTyping deletes the nick from the store map and
		// reassigns it, but Svelte 5's proxy tracking does not invalidate
		// $deriveds on that path — the indicator used to linger until the
		// next 1s ticker tick (and forever, pre-ticker). The store's
		// typingVersion counter forces immediate invalidation.
		const net = createNetwork({ networkId: 'net1', currentNick: 'tester' });
		net.buffers.push(createBuffer({ name: '#general' }));
		ircState.networks.push(net);
		ircState.activeBuffer.networkId = 'net1';
		ircState.activeBuffer.bufferName = '#general';
		setTyping('net1', '#general', 'Alice');
		flushSync();

		render(InputArea, { props: { onSendMessage: mockSendMessage, onSendRaw: mockSendRaw } });
		flushSync();

		expect(page.getByText('Alice is typing').query()).not.toBeNull();

		clearTyping('net1', '#general', 'Alice');
		flushSync();

		// No fake timers, no ticker advance — the clear must be reactive.
		expect(page.getByText('Alice is typing').query()).toBeNull();
	});

	it('hides the typing indicator on its own after the 6.5s expiry window (no new TAGMSGs)', async () => {
		// Regression: typingNicks was a plain $derived that only re-ran when
		// ircState mutated. After the final TAGMSG nothing re-evaluated the
		// store's 6.5s expiry, so "Alice is typing" stuck forever in a quiet
		// channel. The 1s ticker (running only while someone is inside the
		// window) must expire Alice without any new events.
		//
		// Fake timers must be installed BEFORE render so the ticker interval
		// is created faked; leave setTimeout real so the test harness stays
		// responsive. Date is faked so the store's wall-clock expiry advances
		// with the fake clock.
		vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
		try {
			const net = createNetwork({ networkId: 'net1', currentNick: 'tester' });
			net.buffers.push(createBuffer({ name: '#general' }));
			ircState.networks.push(net);
			ircState.activeBuffer.networkId = 'net1';
			ircState.activeBuffer.bufferName = '#general';
			setTyping('net1', '#general', 'Alice');
			flushSync();

			render(InputArea, { props: { onSendMessage: mockSendMessage, onSendRaw: mockSendRaw } });
			flushSync();

			expect(page.getByText('Alice is typing').query()).not.toBeNull();

			vi.advanceTimersByTime(7000);
			flushSync();

			expect(page.getByText('Alice is typing').query()).toBeNull();
		} finally {
			vi.useRealTimers();
		}
	});

	it('gear turns an engaged style off, and the next click opens the editor on it', async () => {
		const net = createNetwork({ networkId: 'net1', currentNick: 'tester' });
		net.buffers.push(createBuffer({ name: '#general' }));
		ircState.networks.push(net);
		ircState.activeBuffer.networkId = 'net1';
		ircState.activeBuffer.bufferName = '#general';
		ircState.showComposeStyle = false;
		globalPrefs.composeStyle = {
			...DEFAULT_COMPOSE_STYLE,
			bold: true,
			color: { kind: 'solid', fg: 4, bg: null },
		};

		render(InputArea, { props: { onSendMessage: mockSendMessage, onSendRaw: mockSendRaw } });
		flushSync();

		// Direct dispatchEvent for the same reason as the emoji test above:
		// vitest-browser reports toolbar cells as "not visible" headless.
		const gear = () => document.querySelector('.stylecell') as HTMLElement;
		expect(gear().getAttribute('aria-label')).toBe('Turn text style off');

		// Engaged: the click is a switch, not a trip through the editor.
		gear().dispatchEvent(new MouseEvent('click', { bubbles: true }));
		flushSync();
		expect(globalPrefs.composeStyle.bold).toBe(false);
		expect(globalPrefs.composeStyle.color.kind).toBe('none');
		expect(ircState.showComposeStyle).toBe(false);
		// …and the style it switched off is remembered for the editor.
		expect(globalPrefs.composeStyleLast.bold).toBe(true);
		expect(globalPrefs.composeStyleLast.color.kind).toBe('solid');

		// Off: the same gear now routes to the editor.
		expect(gear().getAttribute('aria-label')).toBe('Text style');
		gear().dispatchEvent(new MouseEvent('click', { bubbles: true }));
		flushSync();
		expect(ircState.showComposeStyle).toBe(true);
		expect(window.location.search).toBe('?/text-style');

		ircState.showComposeStyle = false;
		history.replaceState({}, '', '/');
	});

	describe('typing heartbeat (stuck-indicator regression)', () => {
		// "p34c3 is typing" stuck for hours: the heartbeat re-sent `active`
		// every 3s as long as the compose box was non-empty, with no idle
		// cutoff, no blur handling, and `done` aimed at the wrong buffer on
		// switch. Typing sends go through the onSendRaw prop so the mock
		// observes the exact wire text.
		function setupTyping() {
			const net = createNetwork({ networkId: 'net1', currentNick: 'tester' });
			net.buffers.push(createBuffer({ name: '#general' }));
			net.buffers.push(createBuffer({ name: '#random' }));
			ircState.networks.push(net);
			ircState.activeBuffer.networkId = 'net1';
			ircState.activeBuffer.bufferName = '#general';
			flushSync();
			render(InputArea, { props: { onSendMessage: mockSendMessage, onSendRaw: mockSendRaw } });
			return page.getByRole('textbox', { name: /message input/i });
		}
		const tagmsg = (v: string, buf = '#general') => `@+typing=${v} TAGMSG ${buf}`;

		it('sends active on first input and done when the text is cleared', async () => {
			const textarea = setupTyping();
			await textarea.fill('hi');
			flushSync();
			expect(mockSendRaw).toHaveBeenCalledWith('net1', tagmsg('active'));
			await textarea.fill('');
			flushSync();
			expect(mockSendRaw).toHaveBeenCalledWith('net1', tagmsg('done'));
		});

		it('stops the heartbeat after 10s without a keystroke and sends done', async () => {
			const textarea = setupTyping();
			try {
				vi.useFakeTimers();
				await textarea.fill('hi');
				flushSync();
				expect(mockSendRaw).toHaveBeenCalledTimes(1);
				vi.advanceTimersByTime(3000);
				expect(mockSendRaw).toHaveBeenCalledTimes(2);
				// Heartbeats at +6s/+9s are still inside the window; the
				// bow-out fires at +12s. Advance to it exactly.
				vi.advanceTimersByTime(9000);
				expect(mockSendRaw).toHaveBeenLastCalledWith('net1', tagmsg('done'));
				const calls = mockSendRaw.mock.calls.length;
				vi.advanceTimersByTime(9000);
				expect(mockSendRaw.mock.calls.length).toBe(calls);
			} finally {
				vi.useRealTimers();
			}
		});

		it('a keystroke inside the window keeps the heartbeat alive', async () => {
			const textarea = setupTyping();
			try {
				vi.useFakeTimers();
				await textarea.fill('hi');
				flushSync();
				vi.advanceTimersByTime(9000);
				// Still typing at 9s: refresh, no done.
				await textarea.fill('hi there');
				flushSync();
				vi.advanceTimersByTime(3000);
				expect(mockSendRaw).toHaveBeenLastCalledWith('net1', tagmsg('active'));
				expect(mockSendRaw).not.toHaveBeenCalledWith('net1', tagmsg('done'));
			} finally {
				vi.useRealTimers();
			}
		});

		it('sends done to the old buffer on switch, not the new one', async () => {
			setupTyping();
			const textarea = page.getByRole('textbox', { name: /message input/i });
			await textarea.fill('hi');
			flushSync();
			expect(mockSendRaw).toHaveBeenCalledWith('net1', tagmsg('active'));
			ircState.activeBuffer.bufferName = '#random';
			flushSync();
			expect(mockSendRaw).toHaveBeenCalledWith('net1', tagmsg('done'));
			expect(mockSendRaw).not.toHaveBeenCalledWith('net1', expect.stringContaining('TAGMSG #random'));
		});

		it('sends done and stops on window blur', async () => {
			const textarea = setupTyping();
			try {
				vi.useFakeTimers();
				await textarea.fill('hi');
				flushSync();
				window.dispatchEvent(new Event('blur'));
				flushSync();
				expect(mockSendRaw).toHaveBeenLastCalledWith('net1', tagmsg('done'));
				const calls = mockSendRaw.mock.calls.length;
				vi.advanceTimersByTime(9000);
				expect(mockSendRaw.mock.calls.length).toBe(calls);
			} finally {
				vi.useRealTimers();
			}
		});

		it('sends nothing while sharing is off, and bows out when switched off mid-draft', async () => {
			const textarea = setupTyping();
			globalPrefs.typingIndicator = false;
			await textarea.fill('hi');
			flushSync();
			expect(mockSendRaw).not.toHaveBeenCalledWith('net1', expect.stringContaining('TAGMSG'));
			globalPrefs.typingIndicator = true;
			await textarea.fill('hi!');
			flushSync();
			expect(mockSendRaw).toHaveBeenCalledWith('net1', tagmsg('active'));
			globalPrefs.typingIndicator = false;
			flushSync();
			expect(mockSendRaw).toHaveBeenLastCalledWith('net1', tagmsg('done'));
		});
	});
});
