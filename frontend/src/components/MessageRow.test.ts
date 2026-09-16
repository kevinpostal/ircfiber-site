import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page, userEvent } from 'vitest/browser';
import { flushSync } from 'svelte';
import MessageRow from './MessageRow.svelte';
import { createMessage, createNetwork, createBuffer, createMember } from '../test/factories';
import { ircState } from '../stores/ircStore.svelte';

vi.mock('/src/stores/wsConnection.svelte.ts', () => ({
  sendRaw: vi.fn(),
  sendJson: vi.fn(),
  sendMessage: vi.fn(),
  setMaxEid: vi.fn(),
}));

import { sendRaw } from '/src/stores/wsConnection.svelte.ts';

function resetState(): void {
	ircState.networks.length = 0;
	ircState.activeBuffer.networkId = null;
	ircState.activeBuffer.bufferName = null;
	ircState.messages = {};
	ircState.processedMessages = {};
	ircState.replyTarget = null;
	ircState.reactTarget = null;
	ircState.messageActions = null;
	document.body.innerHTML = '';
}

beforeEach(() => {
	resetState();
	vi.clearAllMocks();
});

describe('MessageRow', () => {
	it('renders PRIVMSG with nick and text', async () => {
		const msg = createMessage({ nick: 'alice', text: 'hello world' });
		render(MessageRow, { props: { msg } });

		await expect.element(page.getByText('alice')).toBeInTheDocument();
		await expect.element(page.getByText('hello world')).toBeInTheDocument();
	});

	it('renders the avatar outside authorWrap so it is not clipped', async () => {
		const msg = createMessage({ nick: 'alice', text: 'hello world' });
		render(MessageRow, { props: { msg } });

		const row = document.querySelector('.messageRow');
		const avatar = row?.querySelector('.messageAvatar');
		expect(avatar).toBeInTheDocument();
		expect(avatar?.closest('.authorWrap')).toBeNull();
	});

	it('hides the avatar for sameAuthor rows', async () => {
		const msg = createMessage({ nick: 'alice', text: 'hello world' });
		render(MessageRow, { props: { msg, isSameAuthor: true } });

		const row = document.querySelector('.messageRow.sameAuthor');
		expect(row).toBeInTheDocument();
		expect(row?.querySelector('.messageAvatar')).toBeInTheDocument();
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

	it('renders MODE change as an IRCCloud mode sentence', async () => {
		const msg = createMessage({ command: 'MODE', nick: 'alice', params: ['#chan', '+o', 'bob'] });
		render(MessageRow, { props: { msg } });

		const symbol = document.querySelector('.mode_prefix.mode_symbol.mode_OP');
		expect(symbol).toBeInTheDocument();
		expect(symbol?.textContent).toBe('@');
		const moded = document.querySelector('.moded.mode_OP');
		expect(moded?.textContent).toBe('bob');
		expect(document.querySelector('.mode')?.textContent).toBe('opped');
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

	it('applies blockArt class to plain multi-line box-drawing art without color codes', async () => {
		const art = [
			'┌───────┐  ┌───────┐  ┌───────┐',
			'│  IRC  │  │ FIBER │  │  NET  │',
			'│       │  │       │  │       │',
			'│  BOX  │  │  ART  │  │  ROW  │',
			'└───────┘  └───────┘  └───────┘',
		].join('\n');
		const msg = createMessage({ nick: 'carol', text: art });
		render(MessageRow, { props: { msg } });

		expect(document.querySelector('.messageRow.blockArt')).toBeInTheDocument();
	});

	it('does not flag a single normal chat line as blockArt', async () => {
		const msg = createMessage({ nick: 'dave', text: 'hello everyone, how is it going?' });
		render(MessageRow, { props: { msg } });

		expect(document.querySelector('.messageRow.blockArt')).not.toBeInTheDocument();
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

	it('renders the real name next to the nick from the member list', async () => {
		const net = createNetwork({ networkId: 'net1' });
		const buf = createBuffer({
			name: '#chan',
			users: [createMember({ nick: 'alice', realname: 'Alice Smith' })],
		});
		net.buffers.push(buf);
		ircState.networks.push(net);
		ircState.activeBuffer.networkId = 'net1';
		ircState.activeBuffer.bufferName = '#chan';
		flushSync();

		const msg = createMessage({ nick: 'alice', text: 'hello', command: 'PRIVMSG' });
		render(MessageRow, { props: { msg } });

		expect(document.querySelector('.author-realname')?.textContent).toBe('Alice Smith');
	});

	it('falls back to the network-wide realname cache when the sender is not a member', async () => {
		// PM counterparts / users who left the channel / history rows have no
		// entry in the active buffer's member list. The engine's network-wide
		// realname cache (persisted on the Network object by the sync handler)
		// must still surface the real name.
		const net = createNetwork({ networkId: 'net1', realnames: { alice: 'Alice Smith' } });
		// #chan has no member entry for alice (e.g. she left the channel).
		net.buffers.push(createBuffer({ name: '#chan', users: [createMember({ nick: 'bob' })] }));
		ircState.networks.push(net);
		ircState.activeBuffer.networkId = 'net1';
		ircState.activeBuffer.bufferName = '#chan';
		flushSync();

		const msg = createMessage({ nick: 'alice', text: 'hello', command: 'PRIVMSG' });
		render(MessageRow, { props: { msg } });

		expect(document.querySelector('.author-realname')?.textContent).toBe('Alice Smith');
	});

	it('does not render a placeholder realname when unknown', async () => {
		// IRCCloud parity: no member data and no network cache entry means no
		// realname span at all — never an empty or nick-echoing placeholder.
		const net = createNetwork({ networkId: 'net1' });
		net.buffers.push(createBuffer({ name: '#chan' }));
		ircState.networks.push(net);
		ircState.activeBuffer.networkId = 'net1';
		ircState.activeBuffer.bufferName = '#chan';
		flushSync();

		const msg = createMessage({ nick: 'alice', text: 'hello', command: 'PRIVMSG' });
		render(MessageRow, { props: { msg } });

		expect(document.querySelector('.author-realname')).toBeNull();
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
		const visible = (content!.textContent || '').replace(/\u00a0/g, ' ');
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
		const visible = (content!.textContent || '').replace(/\u00a0/g, ' ');
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

	// The author's status is a property of the message (engine `from_mode`),
	// not of the current roster: deriving it live lost the glyph the moment
	// the author quit or was de-opped, and on any history rendered before
	// NAMES landed.
	it('renders the stored fromMode when the author is no longer in the roster', async () => {
		const msg = createMessage({ nick: 'sq', text: 'still an admin', fromMode: '&' });
		render(MessageRow, { props: { msg, memberByNick: new Map() } });

		const symbol = document.querySelector('.authorWrap .mode_prefix.mode_symbol');
		expect(symbol?.textContent).toBe('&');
		expect(symbol?.classList.contains('mode_ADMIN')).toBe(true);
	});

	it('prefers the stored fromMode over the live roster status', async () => {
		// Author has since been promoted to op; the old message must still
		// read as voiced.
		const msg = createMessage({ nick: 'alice', text: 'was voiced then', fromMode: '+' });
		const member = createMember({ nick: '@alice', prefix: '@' });
		render(MessageRow, { props: { msg, memberByNick: new Map([['alice', member]]) } });

		expect(document.querySelector('.authorWrap .mode_prefix.mode_symbol')?.textContent).toBe('+');
	});

	it('falls back to the roster for messages stored before fromMode existed', async () => {
		const msg = createMessage({ nick: 'alice', text: 'legacy row' });
		const member = createMember({ nick: '@alice', prefix: '@' });
		render(MessageRow, { props: { msg, memberByNick: new Map([['alice', member]]) } });

		expect(document.querySelector('.authorWrap .mode_prefix.mode_symbol')?.textContent).toBe('@');
	});

	it('renders an @nick mention as one clickable chip', async () => {
		const onNickClick = vi.fn();
		const msg = createMessage({ nick: 'alice', text: '@zodiac chipping in' });
		const member = createMember({ nick: 'zodiac' });
		render(MessageRow, { props: { msg, onNickClick, memberByNick: new Map([['zodiac', member]]) } });

		const chip = document.querySelector('.content .atMention');
		expect(chip?.textContent).toBe('@zodiac');
		await userEvent.click(page.getByRole('button', { name: '@zodiac' }));
		expect(onNickClick).toHaveBeenCalledTimes(1);
		expect(onNickClick.mock.calls[0][0]).toBe('zodiac');
		expect(onNickClick.mock.calls[0][2]).toBe(member);
	});

	it('opens the popup for a bare in-body nick, with the rosters spelling', async () => {
		const onNickClick = vi.fn();
		const msg = createMessage({ nick: 'alice', text: 'Zodiac said so' });
		const member = createMember({ nick: 'zodiac' });
		render(MessageRow, { props: { msg, onNickClick, memberByNick: new Map([['zodiac', member]]) } });

		const span = document.querySelector<HTMLElement>('.content .bufferLink[data-name="Zodiac"]');
		expect(span).not.toBeNull();
		expect(span?.classList.contains('atMention')).toBe(false);
		await userEvent.click(page.getByText('Zodiac'));
		expect(onNickClick.mock.calls[0][0]).toBe('zodiac');
	});

	it('does not wash the row when somebody else is mentioned', async () => {
		const msg = createMessage({ nick: 'alice', text: '@zodiac not about me' });
		render(MessageRow, { props: { msg, memberByNick: new Map([['zodiac', createMember({ nick: 'zodiac' })]]) } });

		expect(document.querySelector('.content .atMention')).not.toBeNull();
		expect(document.querySelector('.content .mention')).toBeNull();
	});
});

describe('MessageRow — replies and reactions', () => {
	function activeChannel(): void {
		const net = createNetwork({ networkId: 'net1', currentNick: 'me', capabilities: new Set(['message-tags']) });
		net.buffers.push(createBuffer({ name: '#chan', isJoined: true }));
		ircState.networks.push(net);
		ircState.activeBuffer.networkId = 'net1';
		ircState.activeBuffer.bufferName = '#chan';
	}

	it('quotes the replied-to message when it is in the buffer', async () => {
		activeChannel();
		const parent = createMessage({ nick: 'alice', text: 'the original', msgid: 'dc-1' });
		const reply = createMessage({ nick: 'bob', text: 'agreed', msgid: 'dc-2', replyTo: 'dc-1' });
		ircState.messages['net1:#chan'] = [parent, reply];
		flushSync();

		render(MessageRow, { props: { msg: reply } });

		const quote = document.querySelector('.replyQuote');
		expect(quote).toBeInTheDocument();
		expect(quote?.querySelector('.replyNick')?.textContent).toBe('alice:');
		expect(quote?.querySelector('.replyExcerpt')?.textContent).toBe('the original');
	});

	it('falls back to a generic quote when the parent is not loaded', async () => {
		activeChannel();
		const reply = createMessage({ nick: 'bob', text: 'agreed', msgid: 'dc-2', replyTo: 'dc-gone' });
		ircState.messages['net1:#chan'] = [reply];
		flushSync();

		render(MessageRow, { props: { msg: reply } });

		expect(document.querySelector('.replyQuote .replyMissing')?.textContent)
			.toBe('replying to an earlier message');
		expect(document.querySelector('.replyQuote .replyNick')).toBeNull();
	});

	it('renders a chip per emoji with its count, nicks and own-state', async () => {
		activeChannel();
		const msg = createMessage({
			nick: 'alice', text: 'hello', msgid: 'dc-1',
			reactions: { '👍': ['bob', 'me'], '🎉': ['carol'] },
		});
		ircState.messages['net1:#chan'] = [msg];
		flushSync();

		render(MessageRow, { props: { msg } });

		const chips = Array.from(document.querySelectorAll('.reaction'));
		expect(chips.map(c => c.querySelector('.reactionEmoji')?.textContent)).toEqual(['👍', '🎉']);
		expect(chips.map(c => c.querySelector('.reactionCount')?.textContent)).toEqual(['2', '1']);
		expect(chips[0].getAttribute('title')).toBe('bob, me');
		// Our own reaction is marked so a second click removes it.
		expect(chips[0].classList.contains('own')).toBe(true);
		expect(chips[1].classList.contains('own')).toBe(false);
	});

	it('offers Reply and React on a chat row but not on a system row', async () => {
		activeChannel();
		const chat = createMessage({ nick: 'alice', text: 'hello', msgid: 'dc-1' });
		ircState.messages['net1:#chan'] = [chat];
		flushSync();
		render(MessageRow, { props: { msg: chat } });
		expect(document.querySelector('.rowAction.reply')).toBeInTheDocument();
		expect(document.querySelector('.rowAction.react')).toBeInTheDocument();

		document.body.innerHTML = '';
		const join = createMessage({ command: 'JOIN', nick: 'alice', msgid: 'dc-3' });
		render(MessageRow, { props: { msg: join } });
		expect(document.querySelector('.rowAction.reply')).toBeNull();
	});

	it('sets the store reply target from the Reply action', async () => {
		activeChannel();
		const msg = createMessage({ nick: 'alice', text: 'the original', msgid: 'dc-1' });
		ircState.messages['net1:#chan'] = [msg];
		flushSync();

		render(MessageRow, { props: { msg } });
		(document.querySelector('.rowAction.reply') as HTMLButtonElement).click();
		flushSync();

		expect(ircState.replyTarget).toEqual({
			networkId: 'net1', bufferName: '#chan', msgid: 'dc-1',
			nick: 'alice', excerpt: 'the original',
		});
	});

	it('opens the quick strip from React and sends one-click reactions through the store', async () => {
		activeChannel();
		const msg = createMessage({ nick: 'alice', text: 'hello', msgid: 'dc-1' });
		ircState.messages['net1:#chan'] = [msg];
		flushSync();
		render(MessageRow, { props: { msg } });

		(document.querySelector('.rowAction.react') as HTMLButtonElement).click();
		flushSync();
		expect(document.querySelector('.rowActions.stripOpen')).toBeInTheDocument();

		(document.querySelector('.quickReaction[aria-label="React 👍"]') as HTMLButtonElement).click();
		flushSync();
		expect(sendRaw).toHaveBeenCalledWith('net1', '@+reply=dc-1;+draft/react=👍 TAGMSG #chan');
		// Applied optimistically to the row in the store; the strip closes.
		expect(ircState.messages['net1:#chan'][0].reactions).toEqual({ '👍': ['me'] });
		expect(document.querySelector('.rowActions.stripOpen')).toBeNull();
	});

	it('unreacts from the quick strip when the reaction is already ours', async () => {
		activeChannel();
		const msg = createMessage({ nick: 'alice', text: 'hello', msgid: 'dc-1', reactions: { '👍': ['bob', 'me'] } });
		ircState.messages['net1:#chan'] = [msg];
		flushSync();
		render(MessageRow, { props: { msg } });

		const thumb = document.querySelector('.quickReaction[aria-label="React 👍"]') as HTMLButtonElement;
		expect(thumb.classList.contains('own')).toBe(true);
		thumb.click();
		flushSync();
		expect(sendRaw).toHaveBeenCalledWith('net1', '@+reply=dc-1;+draft/unreact=👍 TAGMSG #chan');
		expect(ircState.messages['net1:#chan'][0].reactions).toEqual({ '👍': ['bob'] });
	});

	it('publishes the row as the actions target from More, anchored at the button', async () => {
		activeChannel();
		const msg = createMessage({ nick: 'alice', text: 'hello', msgid: 'dc-1' });
		ircState.messages['net1:#chan'] = [msg];
		flushSync();
		render(MessageRow, { props: { msg } });

		(document.querySelector('.rowAction.more') as HTMLButtonElement).click();
		flushSync();
		expect(ircState.messageActions).toMatchObject({ networkId: 'net1', bufferName: '#chan', sheet: false });
		expect(ircState.messageActions?.msg.msgid).toBe('dc-1');
		expect(ircState.messageActions?.rowEl).toBe(document.querySelector('.row.messageRow'));
	});

	it('right-click opens the actions menu, except on a link', async () => {
		activeChannel();
		const msg = createMessage({ nick: 'alice', text: 'see https://example.com/x', msgid: 'dc-1' });
		ircState.messages['net1:#chan'] = [msg];
		flushSync();
		render(MessageRow, { props: { msg } });
		const row = document.querySelector('.row.messageRow') as HTMLElement;

		const onLink = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 30, clientY: 40 });
		row.querySelector('a')!.dispatchEvent(onLink);
		flushSync();
		expect(onLink.defaultPrevented).toBe(false);
		expect(ircState.messageActions).toBeNull();

		const onRow = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 30, clientY: 40 });
		row.dispatchEvent(onRow);
		flushSync();
		expect(onRow.defaultPrevented).toBe(true);
		expect(ircState.messageActions).toMatchObject({ x: 30, y: 40, sheet: false });
		expect(ircState.messageActions?.msg.msgid).toBe('dc-1');
	});

	it('long-press opens the sheet; a 20px drift (scroll) cancels it', async () => {
		vi.useFakeTimers();
		try {
			activeChannel();
			const msg = createMessage({ nick: 'alice', text: 'hello', msgid: 'dc-1' });
			ircState.messages['net1:#chan'] = [msg];
			flushSync();
			render(MessageRow, { props: { msg } });
			const row = document.querySelector('.row.messageRow') as HTMLElement;
			const touch = (x: number, y: number) => new Touch({ identifier: 1, target: row, clientX: x, clientY: y });
			const touchEvent = (type: string, x: number, y: number) =>
				new TouchEvent(type, { bubbles: true, cancelable: true, touches: [touch(x, y)] });

			row.dispatchEvent(touchEvent('touchstart', 10, 10));
			row.dispatchEvent(touchEvent('touchmove', 30, 10));
			vi.advanceTimersByTime(600);
			flushSync();
			expect(ircState.messageActions).toBeNull();

			row.dispatchEvent(touchEvent('touchstart', 10, 10));
			vi.advanceTimersByTime(499);
			expect(ircState.messageActions).toBeNull();
			vi.advanceTimersByTime(1);
			flushSync();
			expect(ircState.messageActions).toMatchObject({ networkId: 'net1', bufferName: '#chan', sheet: true, x: 10, y: 10 });
		} finally {
			vi.useRealTimers();
		}
	});
});

describe('MessageRow — a server that blocks client-only tags', () => {
	/** `deny` is the raw CLIENTTAGDENY 005 token value. */
	function blockedChannel(deny: string): void {
		const net = createNetwork({
			networkId: 'net1', currentNick: 'me',
			capabilities: new Set(['message-tags']),
			isupport: { CLIENTTAGDENY: deny },
		});
		net.buffers.push(createBuffer({ name: '#chan', isJoined: true }));
		ircState.networks.push(net);
		ircState.activeBuffer.networkId = 'net1';
		ircState.activeBuffer.bufferName = '#chan';
	}

	it('hides Reply, React and the quick strip, keeps More, and renders chips inert', async () => {
		blockedChannel('*');
		const msg = createMessage({ nick: 'alice', text: 'hello', msgid: 'dc-1', reactions: { '👍': ['bob'] } });
		ircState.messages['net1:#chan'] = [msg];
		flushSync();
		render(MessageRow, { props: { msg } });

		expect(document.querySelector('.rowAction.reply')).toBeNull();
		expect(document.querySelector('.rowAction.react')).toBeNull();
		expect(document.querySelector('.reactStrip')).toBeNull();
		// Copy/Edit/Delete send no client tag, so More stays.
		expect(document.querySelector('.rowAction.more')).toBeInTheDocument();

		// A received reaction is information and keeps rendering, but toggling
		// it would send a TAGMSG this server drops.
		const chip = document.querySelector('.reaction') as HTMLButtonElement;
		expect(chip).toBeInTheDocument();
		expect(chip.disabled).toBe(true);
		chip.click();
		flushSync();
		expect(sendRaw).not.toHaveBeenCalled();
	});

	it('restores both affordances when the token exempts their tags', async () => {
		blockedChannel('*,-reply,-draft/react,-draft/unreact');
		const msg = createMessage({ nick: 'alice', text: 'hello', msgid: 'dc-1' });
		ircState.messages['net1:#chan'] = [msg];
		flushSync();
		render(MessageRow, { props: { msg } });

		expect(document.querySelector('.rowAction.reply')).toBeInTheDocument();
		expect(document.querySelector('.rowAction.react')).toBeInTheDocument();
	});
});
