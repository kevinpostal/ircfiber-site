import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page, userEvent } from 'vitest/browser';
import { flushSync } from 'svelte';
import BufferHeader from './BufferHeader.svelte';
import { createNetwork, createBuffer, createMember } from '../test/factories';
import { ircState } from '../stores/ircStore.svelte';

vi.mock('/src/stores/api', () => ({
    fetchMe: vi.fn(async () => ({ username: 'tester', email: 'tester@test.local' })),
    fetchHealth: vi.fn(async () => ({ status: 'healthy', services: {} })),
    loadHistory: vi.fn(async () => []),
    reconnectNetwork: vi.fn(async () => undefined),
    disconnectNetwork: vi.fn(async () => undefined),
    joinChannel: vi.fn(async () => undefined),
    addNetwork: vi.fn(async () => undefined),
    updateNetwork: vi.fn(async () => undefined),
    deleteNetwork: vi.fn(async () => undefined),
    archiveChannel: vi.fn(async () => undefined),
    unarchiveChannel: vi.fn(async () => undefined),
}));

import { reconnectNetwork, disconnectNetwork } from '../stores/api';

function resetState(): void {
    ircState.networks.length = 0;
    ircState.activeBuffer.networkId = null;
    ircState.activeBuffer.bufferName = null;
}

beforeEach(() => {
	resetState();
});

describe('BufferHeader', () => {
	it('renders channel name', async () => {
		const net = createNetwork({ networkId: 'net1' });
		net.buffers.push(createBuffer({ name: '#general' }));
		ircState.networks.push(net);
		ircState.activeBuffer.networkId = 'net1';
		ircState.activeBuffer.bufferName = '#general';
		flushSync();

		render(BufferHeader, {
			props: { onAddNetwork: vi.fn(), onEditNetwork: vi.fn(), onJoinChannel: vi.fn(), onToggleMembers: vi.fn() },
		});

		await expect.element(page.getByText('#general')).toBeInTheDocument();
	});

	it('renders member count for channels', async () => {
		const net = createNetwork({ networkId: 'net1' });
		net.buffers.push(
			createBuffer({ name: '#general', users: [createMember({ nick: 'alice' }), createMember({ nick: 'bob' })] }),
		);
		ircState.networks.push(net);
		ircState.activeBuffer.networkId = 'net1';
		ircState.activeBuffer.bufferName = '#general';
		flushSync();

		render(BufferHeader, {
			props: { onAddNetwork: vi.fn(), onEditNetwork: vi.fn(), onJoinChannel: vi.fn(), onToggleMembers: vi.fn() },
		});

		expect(document.querySelector('#member-count')).toHaveTextContent('2');
	});

	it('renders topic when available', async () => {
		const net = createNetwork({ networkId: 'net1' });
		net.buffers.push(createBuffer({ name: '#general', topic: 'Welcome to #general' }));
		ircState.networks.push(net);
		ircState.activeBuffer.networkId = 'net1';
		ircState.activeBuffer.bufferName = '#general';
		flushSync();

		render(BufferHeader, {
			props: { onAddNetwork: vi.fn(), onEditNetwork: vi.fn(), onJoinChannel: vi.fn(), onToggleMembers: vi.fn() },
		});

		await expect.element(page.getByText('Welcome to #general')).toBeInTheDocument();
	});

	it('does not show edit/connect/disconnect for channels (IRCCloud style)', async () => {
		const net = createNetwork({ networkId: 'net1', connected: true });
		net.buffers.push(createBuffer({ name: '#general' }));
		ircState.networks.push(net);
		ircState.activeBuffer.networkId = 'net1';
		ircState.activeBuffer.bufferName = '#general';
		flushSync();

		render(BufferHeader, {
			props: { onAddNetwork: vi.fn(), onEditNetwork: vi.fn(), onJoinChannel: vi.fn(), onToggleMembers: vi.fn() },
		});

		// IRCCloud: channels only show member count + options gear
		expect(page.getByRole('button', { name: /edit/i })).not.toBeInTheDocument();
		expect(page.getByRole('button', { name: /disconnect/i })).not.toBeInTheDocument();
		expect(document.querySelector('#member-count')).toBeInTheDocument();
		expect(document.querySelector('.bufferOptions')).toBeInTheDocument();
	});

	it('shows edit/connect/disconnect for server buffer', async () => {
		const net = createNetwork({ networkId: 'net1', connected: true });
		net.buffers.push(createBuffer({ name: '_server', type: 'server' }));
		ircState.networks.push(net);
		ircState.activeBuffer.networkId = 'net1';
		ircState.activeBuffer.bufferName = '_server';
		flushSync();

		render(BufferHeader, {
			props: { onAddNetwork: vi.fn(), onEditNetwork: vi.fn(), onJoinChannel: vi.fn(), onToggleMembers: vi.fn() },
		});

		await expect.element(page.getByRole('button', { name: /edit/i })).toBeInTheDocument();
		await expect.element(page.getByRole('button', { name: /disconnect/i })).toBeInTheDocument();
	});

	it('shows connect button for server buffer when disconnected', async () => {
		const net = createNetwork({ networkId: 'net1', connected: false });
		ircState.networks.push(net);
		ircState.activeBuffer.networkId = 'net1';
		ircState.activeBuffer.bufferName = '_server';
		flushSync();

		render(BufferHeader, {
			props: { onAddNetwork: vi.fn(), onEditNetwork: vi.fn(), onJoinChannel: vi.fn(), onToggleMembers: vi.fn() },
		});

		await expect.element(page.getByRole('button', { name: /connect/i })).toBeInTheDocument();
	});

	it('calls onToggleMembers', async () => {
		const onToggleMembers = vi.fn();
		const net = createNetwork({ networkId: 'net1' });
		net.buffers.push(createBuffer({ name: '#general' }));
		ircState.networks.push(net);
		ircState.activeBuffer.networkId = 'net1';
		ircState.activeBuffer.bufferName = '#general';
		flushSync();

		render(BufferHeader, {
			props: { onAddNetwork: vi.fn(), onEditNetwork: vi.fn(), onJoinChannel: vi.fn(), onToggleMembers, memberPanelOpen: true },
		});

		const btn = page.getByRole('button', { name: /members list/i });
		await expect.element(btn).toBeInTheDocument();
		await userEvent.click(btn);
		expect(onToggleMembers).toHaveBeenCalled();
	});

	it('switches to server buffer when Connect is clicked on server buffer', async () => {
		const net = createNetwork({ networkId: 'net1', connected: false, connectionState: 'disconnected' });
		net.buffers.push(createBuffer({ name: '_server', type: 'server' }));
		ircState.networks.push(net);
		ircState.activeBuffer.networkId = 'net1';
		ircState.activeBuffer.bufferName = '_server';
		flushSync();

		render(BufferHeader, {
			props: { onAddNetwork: vi.fn(), onEditNetwork: vi.fn(), onJoinChannel: vi.fn(), onToggleMembers: vi.fn() },
		});

		const connectBtn = page.getByRole('button', { name: /connect/i });
		await expect.element(connectBtn).toBeInTheDocument();
		await userEvent.click(connectBtn);

		// Verify the active buffer switched to _server
		expect(ircState.activeBuffer.networkId).toBe('net1');
		expect(ircState.activeBuffer.bufferName).toBe('_server');

		// Verify connected state changed instantly (not waiting for server)
		const updatedNet = ircState.networks.find(n => n.networkId === 'net1');
		expect(updatedNet?.connected).toBe(true);
		expect(updatedNet?.connectionState).toBe('connecting');

		// Verify the reconnect API was called
		expect(reconnectNetwork).toHaveBeenCalledWith('net1');
	});
});
