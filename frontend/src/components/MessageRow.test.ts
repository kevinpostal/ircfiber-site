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

	it('renders NICK change as single row with IRCCloud-style "oldNick → newNick" format', async () => {
		// Single NICK events are NOT wrapped in a JOINPART_GROUP (to avoid
		// the role="button" scroll-capture issue). They render as a regular
		// message row with the simplified "oldNick → newNick" format.
		const msg = createMessage({ command: 'NICK', nick: 'alice', params: ['alice', 'newalice'] });
		render(MessageRow, { props: { msg } });

		await expect.element(page.getByText('newalice')).toBeInTheDocument();
		await expect.element(page.getByText('alice')).toBeInTheDocument();
		await expect.element(page.getByText('→')).toBeInTheDocument();
		expect(document.querySelector('.collapseWidget')).toBeInTheDocument();
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

	it('applies bot class to messages from bot members so ANSI art renders without gaps', async () => {
		const net = createNetwork({ networkId: 'net1' });
		const buf = createBuffer({
			name: '#chan',
			users: [createMember({ nick: 'scroll', isBot: true })],
		});
		net.buffers.push(buf);
		ircState.networks.push(net);
		ircState.activeBuffer.networkId = 'net1';
		ircState.activeBuffer.bufferName = '#chan';
		flushSync();

		const msg = createMessage({ nick: 'scroll', text: '\x0304,08 test ' });
		render(MessageRow, { props: { msg } });

		expect(document.querySelector('.messageRow.bot')).toBeInTheDocument();
	});

	it('applies blockArt class to messages containing block characters from regular users', async () => {
		const msg = createMessage({ nick: 'Carlos', text: '\x0304,08 ███▀▀▄ ' });
		render(MessageRow, { props: { msg } });

		expect(document.querySelector('.messageRow.blockArt')).toBeInTheDocument();
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

	it('truncates long PRIVMSG bodies to 20 lines with a "Show more" button', async () => {
		const lines: string[] = [];
		for (let i = 0; i < 25; i++) lines.push(`line ${i}`);
		const text = lines.join('\n');
		const msg = createMessage({ nick: 'alice', text });
		render(MessageRow, { props: { msg } });

		// The first 20 lines render, the 21st and beyond are hidden
		// behind the "Show more" button.
		expect(document.querySelector('.longMessageContent')).toBeInTheDocument();
		const content = document.querySelector('.longMessageContent');
		expect(content).toBeTruthy();
		const visible = content!.textContent || '';
		expect(visible).toContain('line 0');
		expect(visible).toContain('line 19');
		expect(visible).not.toContain('line 20');
		expect(visible).not.toContain('line 24');

		// "Show more" button shows the line count beyond the cap
		const button = document.querySelector('.messageTruncated');
		expect(button).toBeInTheDocument();
		expect(button?.textContent).toMatch(/Show more \(5 lines\)/);
	});

	it('expands a truncated PRIVMSG when "Show more" is clicked', async () => {
		const lines: string[] = [];
		for (let i = 0; i < 25; i++) lines.push(`line ${i}`);
		const text = lines.join('\n');
		const msg = createMessage({ nick: 'alice', text });
		render(MessageRow, { props: { msg } });

		const button = document.querySelector<HTMLButtonElement>('.messageTruncated');
		expect(button).toBeTruthy();
		await userEvent.click(button!);

		// After clicking, the full body renders
		const content = document.querySelector('.longMessageContent');
		const visible = content!.textContent || '';
		expect(visible).toContain('line 24');
		expect(document.querySelector('.messageTruncated')?.textContent).toContain('Show less');
	});

	it('does not truncate short PRIVMSG bodies', async () => {
		const text = 'a short message';
		const msg = createMessage({ nick: 'alice', text });
		render(MessageRow, { props: { msg } });

		expect(document.querySelector('.longMessageContent')).toBeInTheDocument();
		expect(document.querySelector('.messageTruncated')).not.toBeInTheDocument();
	});
});
