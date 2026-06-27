import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page, userEvent } from 'vitest/browser';
import { flushSync } from 'svelte';
import InputArea from './InputArea.svelte';
import { createNetwork, createBuffer, createMember, createMessage } from '../test/factories';
import { ircState, updateChannelUsers } from '../stores/ircStore.svelte';

vi.mock('/src/stores/api', () => ({
  reconnectNetwork: vi.fn(async () => undefined),
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
}));

import { reconnectNetwork } from '../stores/api';

function resetState(): void {
	ircState.networks.length = 0;
	ircState.activeBuffer.networkId = null;
	ircState.activeBuffer.bufferName = null;
	ircState.messages = {};
}

beforeEach(() => {
	resetState();
	vi.clearAllMocks();
});

describe('InputArea', () => {
	let mockSendMessage: ReturnType<typeof vi.fn>;
	let mockSendRaw: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		mockSendMessage = vi.fn();
		mockSendRaw = vi.fn();
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

		// Verify connection state updated instantly
		const updatedNet = ircState.networks.find(n => n.networkId === 'net1');
		expect(updatedNet?.connected).toBe(true);
		expect(updatedNet?.connectionState).toBe('connecting');

		expect(window.location.pathname).toBe('/irc/TestNet/channel/test');
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
});
