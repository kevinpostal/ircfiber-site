import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page, userEvent } from 'vitest/browser';
import { flushSync } from 'svelte';
import InputArea from './InputArea.svelte';
import { createNetwork, createBuffer, createMember } from '../test/factories';
import { ircState } from '../stores/ircStore.svelte';

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

		// Verify channel buffer was created optimistically in the sidebar
		const testBuf = ircState.networks
			.find(n => n.networkId === 'net1')
			?.buffers.find(b => b.name === '#test');
		expect(testBuf).toBeDefined();
		expect(testBuf?.type).toBe('channel');
		expect(testBuf?.isJoined).toBe(true);

		// Verify connection state updated instantly
		const updatedNet = ircState.networks.find(n => n.networkId === 'net1');
		expect(updatedNet?.connected).toBe(true);
		expect(updatedNet?.connectionState).toBe('connecting');

		expect(window.location.pathname).toBe('/irc/TestNet/channel/test');
	});
});
