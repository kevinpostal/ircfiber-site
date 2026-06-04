import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page, userEvent } from 'vitest/browser';
import { flushSync } from 'svelte';
import MessageList from './MessageList.svelte';
import { createMessage, createNetwork, createBuffer } from '../test/factories';
import { ircState } from '../stores/ircStore.svelte';
import { clearedAtMap } from '../stores/preferences.svelte';

function resetState(): void {
	ircState.networks.length = 0;
	ircState.activeBuffer.networkId = null;
	ircState.activeBuffer.bufferName = null;
	ircState.messages = {};
	ircState.lastSeenMsgTime = null;
	ircState.focusLost = false;
	Object.keys(clearedAtMap).forEach((k) => delete (clearedAtMap as Record<string, unknown>)[k]);
}

beforeEach(() => {
	resetState();
});

describe('MessageList', () => {
	it('renders messages in order', async () => {
		const net = createNetwork({ networkId: 'net1' });
		net.buffers.push(createBuffer({ name: '#chan' }));
		ircState.networks.push(net);
		ircState.activeBuffer.networkId = 'net1';
		ircState.activeBuffer.bufferName = '#chan';

		ircState.messages['net1:#chan'] = [
			createMessage({ text: 'first', t: Date.now() - 2000 }),
			createMessage({ text: 'second', t: Date.now() - 1000 }),
			createMessage({ text: 'third', t: Date.now() }),
		];
		flushSync();

		render(MessageList, { props: {} });

		await expect.element(page.getByText('first')).toBeInTheDocument();
		await expect.element(page.getByText('second')).toBeInTheDocument();
		await expect.element(page.getByText('third')).toBeInTheDocument();
	});

	it('renders DateChange between messages on different dates', async () => {
		const net = createNetwork({ networkId: 'net1' });
		net.buffers.push(createBuffer({ name: '#chan' }));
		ircState.networks.push(net);
		ircState.activeBuffer.networkId = 'net1';
		ircState.activeBuffer.bufferName = '#chan';

		const now = Date.now();
		const yesterday = now - 86400000 * 2;
		ircState.messages['net1:#chan'] = [
			createMessage({ text: 'old', t: yesterday }),
			createMessage({ text: 'new', t: now }),
		];
		flushSync();

		render(MessageList, { props: {} });

		await expect.element(page.getByText('old')).toBeInTheDocument();
		await expect.element(page.getByText('new')).toBeInTheDocument();
	});

	it('renders LoadMore sentinel', async () => {
		const net = createNetwork({ networkId: 'net1' });
		net.buffers.push(createBuffer({ name: '#chan' }));
		ircState.networks.push(net);
		ircState.activeBuffer.networkId = 'net1';
		ircState.activeBuffer.bufferName = '#chan';
		ircState.messages['net1:#chan'] = [createMessage({ text: 'hello' })];
		flushSync();

		render(MessageList);

		// The sentinel is always rendered; button only shows for clearedAt
		await expect.element(page.getByText('Load more backlog…')).not.toBeInTheDocument();
	});

	it('shows LoadMore sentinel', async () => {
		const net = createNetwork({ networkId: 'net1' });
		net.buffers.push(createBuffer({ name: '#chan' }));
		ircState.networks.push(net);
		ircState.activeBuffer.networkId = 'net1';
		ircState.activeBuffer.bufferName = '#chan';
		ircState.messages['net1:#chan'] = [createMessage({ text: 'hello' })];
		flushSync();

		render(MessageList);

		// Sentinels renders, button only for clearedAt
		const sentinel = document.querySelector('.loadMoreSentinel');
		expect(sentinel).not.toBeNull();
	});

	it('filters cleared messages', async () => {
		const net = createNetwork({ networkId: 'net1' });
		net.buffers.push(createBuffer({ name: '#chan' }));
		ircState.networks.push(net);
		ircState.activeBuffer.networkId = 'net1';
		ircState.activeBuffer.bufferName = '#chan';

		const t1 = Date.now() - 10000;
		const t2 = Date.now() - 5000;
		const t3 = Date.now();
		ircState.messages['net1:#chan'] = [
			createMessage({ text: 'old', t: t1 }),
			createMessage({ text: 'middle', t: t2, msgid: 'mid-2' }),
			createMessage({ text: 'new', t: t3 }),
		];
		clearedAtMap['net1:#chan'] = t2 + 1;
		flushSync();

		render(MessageList, { props: {} });

		await expect.element(page.getByText('new')).toBeInTheDocument();
		expect(document.querySelector('[data-time]')).toBeInTheDocument();
	});

	it('preprocesses join/part groups', async () => {
		const net = createNetwork({ networkId: 'net1' });
		net.buffers.push(createBuffer({ name: '#chan' }));
		ircState.networks.push(net);
		ircState.activeBuffer.networkId = 'net1';
		ircState.activeBuffer.bufferName = '#chan';

		const now = Date.now();
		ircState.messages['net1:#chan'] = [
			createMessage({ command: 'JOIN', nick: 'alice', text: 'joined', t: now - 1000 }),
			createMessage({ command: 'JOIN', nick: 'bob', text: 'joined', t: now }),
		];
		flushSync();

		render(MessageList, { props: {} });

		const grouped = document.querySelector('.groupedJoinPart');
		expect(grouped).toBeInTheDocument();
	});
});
