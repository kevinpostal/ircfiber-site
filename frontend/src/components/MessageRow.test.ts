import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page, userEvent } from 'vitest/browser';
import { flushSync } from 'svelte';
import MessageRow from './MessageRow.svelte';
import { createMessage, createNetwork, createBuffer, createMember } from '../test/factories';
import { ircState } from '../stores/ircStore.svelte';

function resetState(): void {
	ircState.networks.length = 0;
	ircState.activeBuffer.networkId = null;
	ircState.activeBuffer.bufferName = null;
	ircState.messages = {};
}

beforeEach(() => {
	resetState();
});

describe('MessageRow', () => {
	it('renders PRIVMSG with nick and text', async () => {
		const msg = createMessage({ nick: 'alice', text: 'hello world' });
		render(MessageRow, { props: { msg } });

		await expect.element(page.getByText('alice')).toBeInTheDocument();
		await expect.element(page.getByText('hello world')).toBeInTheDocument();
	});

	it('renders action (/me) message', async () => {
		const msg = createMessage({ nick: 'alice', text: 'dances', type: 'action' });
		render(MessageRow, { props: { msg } });

		await expect.element(page.getByText('alice')).toBeInTheDocument();
		await expect.element(page.getByText('dances')).toBeInTheDocument();
		expect(document.querySelector('.messageRow.action')).toBeInTheDocument();
	});

	it('renders JOIN system message', async () => {
		const msg = createMessage({ command: 'JOIN', nick: 'alice', prefix: 'alice!user@host' });
		render(MessageRow, { props: { msg } });

		await expect.element(page.getByText(/joined/i)).toBeInTheDocument();
		await expect.element(page.getByText('alice')).toBeInTheDocument();
	});

	it('renders PART system message', async () => {
		const msg = createMessage({ command: 'PART', nick: 'alice', text: 'bye' });
		render(MessageRow, { props: { msg } });

		await expect.element(page.getByText(/left/i)).toBeInTheDocument();
		await expect.element(page.getByText('bye')).toBeInTheDocument();
	});

	it('renders QUIT system message', async () => {
		const msg = createMessage({ command: 'QUIT', nick: 'alice', text: 'Connection reset' });
		render(MessageRow, { props: { msg } });

		await expect.element(page.getByText(/quit/i)).toBeInTheDocument();
	});

	it('renders NICK change message', async () => {
		const msg = createMessage({ command: 'NICK', nick: 'alice', params: ['alice', 'newalice'] });
		render(MessageRow, { props: { msg } });

		await expect.element(page.getByText(/is now known as/i)).toBeInTheDocument();
		await expect.element(page.getByText('newalice')).toBeInTheDocument();
	});

	it('renders TOPIC change', async () => {
		const msg = createMessage({ command: 'TOPIC', nick: 'alice', text: 'New topic here' });
		render(MessageRow, { props: { msg } });

		await expect.element(page.getByText(/changed the topic to:/i)).toBeInTheDocument();
		await expect.element(page.getByText('New topic here')).toBeInTheDocument();
	});

	it('renders MODE change', async () => {
		const msg = createMessage({ command: 'MODE', nick: 'alice', params: ['#chan', '+o', 'bob'] });
		render(MessageRow, { props: { msg } });

		await expect.element(page.getByText(/sets mode/i)).toBeInTheDocument();
	});

	it('renders MOTD_GROUP', async () => {
		const msg = createMessage({ command: 'MOTD_GROUP', lines: ['Line 1', 'Line 2'] });
		render(MessageRow, { props: { msg } });

		await expect.element(page.getByText('Line 1')).toBeInTheDocument();
		await expect.element(page.getByText('Line 2')).toBeInTheDocument();
	});

	it('renders numeric reply (001, 002, etc.)', async () => {
		const msg = createMessage({ command: '001', text: 'Welcome to the network' });
		render(MessageRow, { props: { msg } });

		await expect.element(page.getByText('Welcome to the network')).toBeInTheDocument();
	});

	it('calls onNickClick when nick is clicked', async () => {
		const onNickClick = vi.fn();
		const msg = createMessage({ nick: 'alice', text: 'hello' });
		render(MessageRow, { props: { msg, onNickClick } });

		const nick = page.getByRole('button', { name: 'alice' });
		await expect.element(nick).toBeInTheDocument();
		await userEvent.click(nick);
		expect(onNickClick).toHaveBeenCalledTimes(1);
		expect(onNickClick.mock.calls[0][0]).toBe('alice');
	});

	it('applies highlight class for highlighted messages', async () => {
		const msg = createMessage({ nick: 'alice', text: 'hello' });
		render(MessageRow, { props: { msg, isHighlight: true } });

		expect(document.querySelector('.messageRow.highlight')).toBeInTheDocument();
	});

	it('renders mode prefix for nicks', async () => {
		const net = createNetwork({ networkId: 'net1' });
		const buf = createBuffer({
			name: '#chan',
			users: [createMember({ nick: 'alice', prefix: '@' })],
		});
		net.buffers.push(buf);
		ircState.networks.push(net);
		ircState.activeBuffer.networkId = 'net1';
		ircState.activeBuffer.bufferName = '#chan';
		flushSync();

		const msg = createMessage({ nick: 'alice', text: 'hello', command: 'PRIVMSG' });
		render(MessageRow, { props: { msg } });

		expect(document.querySelector('.mode_prefix')).toBeInTheDocument();
	});
});
