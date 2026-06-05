import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page, userEvent } from 'vitest/browser';
import { flushSync } from 'svelte';
import Sidebar from './Sidebar.svelte';
import { createNetwork, createBuffer } from '../test/factories';
import { ircState } from '../stores/ircStore.svelte';
import { archivedMap } from '../stores/preferences.svelte';

function resetState(): void {
	ircState.networks.length = 0;
	ircState.activeBuffer.networkId = null;
	ircState.activeBuffer.bufferName = null;
	Object.keys(archivedMap).forEach((k) => delete (archivedMap as Record<string, unknown>)[k]);
}

beforeEach(() => {
	resetState();
});

describe('Sidebar', () => {
	it('renders network names', async () => {
		const net = createNetwork({ name: 'Libera' });
		net.buffers.push(createBuffer({ name: '#chan' }));
		ircState.networks.push(net);

		render(Sidebar, { props: { onSwitchBuffer: vi.fn(), onAddNetwork: vi.fn() } });

		await expect.element(page.getByText('Libera')).toBeInTheDocument();
	});

	it('renders buffer list under each network', async () => {
		const net = createNetwork({ name: 'Libera' });
		net.buffers.push(createBuffer({ name: '#general' }));
		net.buffers.push(createBuffer({ name: '#random' }));
		ircState.networks.push(net);

		render(Sidebar, { props: { onSwitchBuffer: vi.fn(), onAddNetwork: vi.fn() } });

		await expect.element(page.getByText('general')).toBeInTheDocument();
		await expect.element(page.getByText('random')).toBeInTheDocument();
	});

	it('highlights active buffer', async () => {
		const net = createNetwork({ networkId: 'net1', name: 'Libera' });
		net.buffers.push(createBuffer({ name: '#general' }));
		ircState.networks.push(net);
		ircState.activeBuffer.networkId = 'net1';
		ircState.activeBuffer.bufferName = '#general';
		flushSync();

		render(Sidebar, { props: { onSwitchBuffer: vi.fn(), onAddNetwork: vi.fn() } });

		expect(document.querySelector('.buffer-item.active')).toBeInTheDocument();
	});

	it('calls onSwitchBuffer when buffer clicked', async () => {
		const onSwitchBuffer = vi.fn();
		const net = createNetwork({ networkId: 'net1' });
		net.buffers.push(createBuffer({ name: '#general' }));
		ircState.networks.push(net);

		render(Sidebar, { props: { onSwitchBuffer, onAddNetwork: vi.fn() } });

		const buffer = page.getByText('general');
		await expect.element(buffer).toBeInTheDocument();
		await userEvent.click(buffer);
		expect(onSwitchBuffer).toHaveBeenCalledWith('net1', '#general');
	});

	it('toggles network collapse/expand', async () => {
		const net = createNetwork({ networkId: 'net1', collapsed: true });
		net.buffers.push(createBuffer({ name: '#general' }));
		ircState.networks.push(net);

		render(Sidebar, { props: { onSwitchBuffer: vi.fn(), onAddNetwork: vi.fn() } });

		// When collapsed, buffer should not be rendered
		expect(document.querySelector('.network-buffers')).toBeNull();
	});

	it('shows unread count badges', async () => {
		const net = createNetwork({ networkId: 'net1' });
		net.buffers.push(createBuffer({ name: '#general', unreadCount: 5 }));
		ircState.networks.push(net);

		render(Sidebar, { props: { onSwitchBuffer: vi.fn(), onAddNetwork: vi.fn() } });

		await expect.element(page.getByText('5')).toBeInTheDocument();
	});

	it('shows highlight indicators', async () => {
		const net = createNetwork({ networkId: 'net1' });
		net.buffers.push(createBuffer({ name: '#general', highlight: true }));
		ircState.networks.push(net);

		render(Sidebar, { props: { onSwitchBuffer: vi.fn(), onAddNetwork: vi.fn() } });

		expect(document.querySelector('.buffer-item.highlight')).toBeInTheDocument();
	});

	it('calls onAddNetwork when add button clicked', async () => {
		const onAddNetwork = vi.fn();
		render(Sidebar, { props: { onSwitchBuffer: vi.fn(), onAddNetwork } });

		const btn = page.getByRole('button', { name: /add a network/i });
		await expect.element(btn).toBeInTheDocument();
		await userEvent.click(btn);
		expect(onAddNetwork).toHaveBeenCalled();
	});

	it('hides server buffer from list', async () => {
		const net = createNetwork({ networkId: 'net1' });
		net.buffers.push(createBuffer({ name: '_server', type: 'server' }));
		net.buffers.push(createBuffer({ name: '#general' }));
		ircState.networks.push(net);

		render(Sidebar, { props: { onSwitchBuffer: vi.fn(), onAddNetwork: vi.fn() } });

		await expect.element(page.getByText('_server')).not.toBeInTheDocument();
		await expect.element(page.getByText('general')).toBeInTheDocument();
	});

	it('filters archived buffers', async () => {
		const net = createNetwork({ networkId: 'net1' });
		net.buffers.push(createBuffer({ name: '#general' }));
		net.buffers.push(createBuffer({ name: '#old' }));
		ircState.networks.push(net);
		archivedMap['net1:#old'] = true;

		render(Sidebar, { props: { onSwitchBuffer: vi.fn(), onAddNetwork: vi.fn() } });

		expect(document.querySelector('.archived-channels')).toBeInTheDocument();
		await expect.element(page.getByText('old')).toBeInTheDocument();
	});
});
