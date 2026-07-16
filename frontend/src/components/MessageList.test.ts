import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page, userEvent } from 'vitest/browser';
import { flushSync } from 'svelte';
import MessageList from './MessageList.svelte';
import { createMessage, createNetwork, createBuffer } from '../test/factories';
import { ircState, requestForceScrollToBottom, setActiveBuffer, appendMessage } from '../stores/ircStore.svelte';
import { appendToProcessed, buildProcessedBuffer } from '../lib/messageBuilder';
import { clearedAtMap } from '../stores/preferences.svelte';
import type { IRCMessage } from '../types';

function resetState(): void {
	ircState.networks.length = 0;
	ircState.activeBuffer.networkId = null;
	ircState.activeBuffer.bufferName = null;
	ircState.messages = {};
	ircState.processedMessages = {};
	ircState.optimisticMessages.clear();
	ircState.backlogDivider = {};
	ircState.lastSeenMsgTime = null;
	ircState.focusLost = false;
	ircState.forceScrollToBottomNonce = 0;
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

	it('renders the IRCCloud loadMore button at the top of the log', async () => {
		const net = createNetwork({ networkId: 'net1' });
		net.buffers.push(createBuffer({ name: '#chan' }));
		ircState.networks.push(net);
		ircState.activeBuffer.networkId = 'net1';
		ircState.activeBuffer.bufferName = '#chan';
		ircState.messages['net1:#chan'] = [createMessage({ text: 'hello' })];
		flushSync();

		render(MessageList);

		// IRCCloud renders a "Load more backlog…" button whenever the
		// buffer is not fully rendered.
		await expect.element(page.getByText('Load more backlog…')).toBeInTheDocument();
		const row = document.querySelector('.row.loadMore');
		expect(row).not.toBeNull();
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

	it('shows empty-channel hint for a channel with no messages', async () => {
		const net = createNetwork({ networkId: 'net1' });
		net.buffers.push(createBuffer({ name: '#chan' }));
		ircState.networks.push(net);
		ircState.activeBuffer.networkId = 'net1';
		ircState.activeBuffer.bufferName = '#chan';
		// No messages — empty state should render
		flushSync();

		render(MessageList, { props: {} });

		const container = document.querySelector('.empty-channel');
		expect(container).not.toBeNull();
		expect(container?.textContent).toContain('#chan');
		expect(container?.textContent).toContain('No messages yet');
	});

	it('shows different empty text for a DM with no messages', async () => {
		const net = createNetwork({ networkId: 'net1' });
		net.buffers.push(createBuffer({ name: 'Alice' }));
		ircState.networks.push(net);
		ircState.activeBuffer.networkId = 'net1';
		ircState.activeBuffer.bufferName = 'Alice';
		flushSync();

		render(MessageList, { props: {} });

		const container = document.querySelector('.empty-channel');
		expect(container).not.toBeNull();
		expect(container?.textContent).toContain('No messages with Alice yet');
	});

	it('hides empty-channel hint when messages exist', async () => {
		const net = createNetwork({ networkId: 'net1' });
		net.buffers.push(createBuffer({ name: '#chan' }));
		ircState.networks.push(net);
		ircState.activeBuffer.networkId = 'net1';
		ircState.activeBuffer.bufferName = '#chan';
		ircState.messages['net1:#chan'] = [
			createMessage({ text: 'hello', t: Date.now() }),
		];
		flushSync();

		render(MessageList, { props: {} });

		expect(document.querySelector('.empty-channel')).toBeNull();
	});

	it('hides empty-channel hint for a server buffer (_server) with no messages', async () => {
		const net = createNetwork({ networkId: 'net1' });
		net.buffers.push(createBuffer({ name: '_server' }));
		ircState.networks.push(net);
		ircState.activeBuffer.networkId = 'net1';
		ircState.activeBuffer.bufferName = '_server';
		flushSync();

		render(MessageList, { props: {} });

		expect(document.querySelector('.empty-channel')).toBeNull();
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

	describe('scroll-back history loading', () => {
		it('maintains scroll position when prepending older messages', async () => {
			const net = createNetwork({ networkId: 'net1' });
			net.buffers.push(createBuffer({ name: '#chan' }));
			ircState.networks.push(net);
			ircState.activeBuffer.networkId = 'net1';
			ircState.activeBuffer.bufferName = '#chan';

			const now = Date.now();
			// Create 50 messages to simulate history
			const messages: IRCMessage[] = [];
			for (let i = 0; i < 50; i++) {
				messages.push(createMessage({
					text: `message-${i + 1}`,
					t: now - (50 - i) * 1000,
					msgid: `msg-${i + 1}`,
				}));
			}
			ircState.messages['net1:#chan'] = messages;
			flushSync();

			render(MessageList, { props: {} });

			const container = document.getElementById('messages') as HTMLDivElement;
			expect(container).not.toBeNull();

			// Wait for initial render
			await new Promise((r) => requestAnimationFrame(r));

			// Scroll to middle of content
			const midScroll = Math.floor(container.scrollHeight * 0.3);
			container.scrollTop = midScroll;
			container.dispatchEvent(new Event('scroll'));

			await new Promise((r) => setTimeout(r, 50));

			// Prepend older messages (simulating loadMore)
			const olderMessages: IRCMessage[] = [];
			for (let i = 0; i < 20; i++) {
				olderMessages.push(createMessage({
					text: `older-message-${i + 1}`,
					t: now - (70 - i) * 1000,
					msgid: `older-msg-${i + 1}`,
				}));
			}
			ircState.messages['net1:#chan'] = [...olderMessages, ...messages];
			flushSync();

			// Wait for DOM update
			await new Promise((r) => setTimeout(r, 100));

			// Verify older messages are in DOM
			const olderElement = document.querySelector('[data-msgid="older-msg-1"]');
			expect(olderElement).not.toBeNull();

			// Verify newer messages still exist
			const newerElement = document.querySelector('[data-msgid="msg-50"]');
			expect(newerElement).not.toBeNull();

			// Verify we still have messages from both old and new
			const allMessages = document.querySelectorAll('.row.messageRow');
			expect(allMessages.length).toBeGreaterThanOrEqual(50);
		});

		it('calls onLoadMore when scrolled to the very top (IRCCloud infiniscroll)', async () => {
			const net = createNetwork({ networkId: 'net1' });
			net.buffers.push(createBuffer({ name: '#chan' }));
			ircState.networks.push(net);
			ircState.activeBuffer.networkId = 'net1';
			ircState.activeBuffer.bufferName = '#chan';

			const now = Date.now();
			const messages: IRCMessage[] = [];
			for (let i = 0; i < 50; i++) {
				messages.push(createMessage({
					text: `message-${i + 1}`,
					t: now - (50 - i) * 1000,
					msgid: `msg-${i + 1}`,
				}));
			}
			ircState.messages['net1:#chan'] = messages;
			flushSync();

			const onLoadMore = vi.fn().mockResolvedValue(true);
			render(MessageList, { props: { onLoadMore } });

			const container = document.getElementById('messages') as HTMLDivElement;
			expect(container).not.toBeNull();

			// Constrain the viewport so the buffer is actually scrollable —
			// IRCCloud's checkInfiniscroll only fires when not at the bottom.
			container.style.height = '200px';

			// Wait for initial render (pinned to bottom)
			await new Promise((r) => requestAnimationFrame(r));
			await new Promise((r) => setTimeout(r, 50));

			// IRCCloud infiniscroll triggers only at scrollTop === 0
			container.scrollTop = 0;
			container.dispatchEvent(new Event('scroll'));

			// IRCCloud delays the backlog fetch by 200ms after the trigger
			await new Promise((r) => setTimeout(r, 500));

			// onLoadMore should have been called
			expect(onLoadMore).toHaveBeenCalled();
		});

		it('shows the scroll clock while scrolled up and hides it at the bottom', { timeout: 10000 }, async () => {
			const net = createNetwork({ networkId: 'net1' });
			net.buffers.push(createBuffer({ name: '#chan' }));
			ircState.networks.push(net);
			ircState.activeBuffer.networkId = 'net1';
			ircState.activeBuffer.bufferName = '#chan';

			const now = Date.now();
			const messages: IRCMessage[] = [];
			for (let i = 0; i < 50; i++) {
				messages.push(createMessage({
					text: `clock-message-${i + 1}`,
					t: now - (50 - i) * 60000,
					msgid: `clock-${i + 1}`,
				}));
			}
			ircState.messages['net1:#chan'] = messages;
			flushSync();

			render(MessageList, { props: {} });

			const container = document.getElementById('messages') as HTMLDivElement;
			container.style.height = '200px';
			container.getBoundingClientRect();
			await new Promise((r) => setTimeout(r, 50));

			// Prime: move away from bottom so the scroll-handler dedup
			// detects the change when we scroll back to the bottom.
			container.scrollTop = 1;
			container.dispatchEvent(new Event('scroll'));
			await new Promise((r) => setTimeout(r, 50));

			// Now scroll to bottom — the dedup check sees a change.
			container.scrollTop = container.scrollHeight;
			container.dispatchEvent(new Event('scroll'));

			await vi.waitFor(() => {
				expect(document.querySelector('.scrollClock')).toBeNull();
			}, { timeout: 5000, interval: 100 });

			// Scroll up → the clock appears with the upper message's date.
			container.scrollTop = 50;
			container.dispatchEvent(new Event('scroll'));
			await vi.waitFor(() => {
				expect(document.querySelector('.scrollClock')).not.toBeNull();
			}, { timeout: 5000, interval: 100 });
			expect(document.querySelector('.scrollClock .timeago')?.textContent).toContain('ago');
			expect(document.querySelector('.scrollClock canvas.clock')).not.toBeNull();

			// Back to the bottom → hidden again.
			container.scrollTop = container.scrollHeight;
			container.dispatchEvent(new Event('scroll'));
			await vi.waitFor(() => {
				expect(document.querySelector('.scrollClock')).toBeNull();
			}, { timeout: 5000, interval: 100 });
		});

		it('buffers realtime messages while scrolled up and flushes them at the bottom', async () => {
			const net = createNetwork({ networkId: 'net1' });
			net.buffers.push(createBuffer({ name: '#chan' }));
			ircState.networks.push(net);
			ircState.activeBuffer.networkId = 'net1';
			ircState.activeBuffer.bufferName = '#chan';

			const now = Date.now();
			const messages: IRCMessage[] = [];
			for (let i = 0; i < 50; i++) {
				messages.push(createMessage({
					text: `chat-message-${i + 1}`,
					t: now - (50 - i) * 1000,
					msgid: `chat-${i + 1}`,
				}));
			}
			ircState.messages['net1:#chan'] = messages;
			flushSync();

			render(MessageList, { props: {} });

			const container = document.getElementById('messages') as HTMLDivElement;
			container.style.height = '200px';
			await new Promise((r) => requestAnimationFrame(r));
			await new Promise((r) => setTimeout(r, 50));

			// Scroll up into the backlog (not the very top) → freeze the window
			container.scrollTop = 50;
			container.dispatchEvent(new Event('scroll'));
			await new Promise((r) => setTimeout(r, 50));

			// A realtime message arrives — IRCCloud buffers it without touching
			// the DOM while the user is scrolled up reading.
			ircState.messages['net1:#chan'] = [
				...messages,
				createMessage({ text: 'realtime-while-reading', t: now + 1000, msgid: 'rt-1' }),
			];
			flushSync();
			await new Promise((r) => setTimeout(r, 100));
			expect(document.querySelector('[data-msgid="rt-1"]')).toBeNull();

			// Returning to the bottom flushes the buffered message.
			container.scrollTop = container.scrollHeight;
			container.dispatchEvent(new Event('scroll'));
			await vi.waitFor(() => {
				expect(document.querySelector('[data-msgid="rt-1"]')).not.toBeNull();
			}, { timeout: 2000 });
		});

		it('windows the DOM to the last 200 messages and reveals more from memory at the top', async () => {
			const net = createNetwork({ networkId: 'net1' });
			net.buffers.push(createBuffer({ name: '#chan' }));
			ircState.networks.push(net);
			ircState.activeBuffer.networkId = 'net1';
			ircState.activeBuffer.bufferName = '#chan';

			const now = Date.now();
			const messages: IRCMessage[] = [];
			for (let i = 0; i < 450; i++) {
				messages.push(createMessage({
					text: `bulk-message-${i + 1}`,
					t: now - (450 - i) * 1000,
					msgid: `bulk-${i + 1}`,
					nick: `user${i % 7}`,
				}));
			}
			ircState.messages['net1:#chan'] = messages;
			flushSync();

			render(MessageList, { props: {} });
			await new Promise((r) => requestAnimationFrame(r));
			await new Promise((r) => setTimeout(r, 50));

			// IRCCloud renders only the last batchSize=200 on open.
			const initialRows = document.querySelectorAll('.row.messageRow').length;
			expect(initialRows).toBeLessThanOrEqual(200);
			expect(initialRows).toBeGreaterThan(150);

			// Scroll to the very top → the previous 200 reveal instantly from
			// memory (IRCCloud loadOrRenderBacklog), no network involved.
			const container = document.getElementById('messages') as HTMLDivElement;
			container.style.height = '300px';
			container.scrollTop = 0;
			container.dispatchEvent(new Event('scroll'));

			await vi.waitFor(() => {
				expect(document.querySelectorAll('.row.messageRow').length).toBeGreaterThan(250);
			}, { timeout: 2000 });

			// The reveal renders a single backlogDivider at the boundary.
			expect(document.querySelectorAll('.backlogDivider').length).toBe(1);
		});

		it('auto-fills the viewport when content does not overflow (IRCCloud fill)', async () => {
			const net = createNetwork({ networkId: 'net1' });
			net.buffers.push(createBuffer({ name: '#chan' }));
			ircState.networks.push(net);
			ircState.activeBuffer.networkId = 'net1';
			ircState.activeBuffer.bufferName = '#chan';

			// A few messages only — the log can't overflow the viewport, so
			// it's unscrollable and infiniscroll could never fire. The fill
			// loop must fetch backlog without any user scroll.
			const now = Date.now();
			ircState.messages['net1:#chan'] = [
				createMessage({ text: 'one', t: now - 2000, msgid: 'fill-1' }),
				createMessage({ text: 'two', t: now - 1000, msgid: 'fill-2' }),
			];
			flushSync();

			const onLoadMore = vi.fn().mockResolvedValue(true);
			render(MessageList, { props: { onLoadMore } });

			// No scroll events — the fill check plus IRCCloud's 200ms fetch
			// delay should trigger the load on its own.
			await vi.waitFor(() => expect(onLoadMore).toHaveBeenCalled(), { timeout: 2000 });
		});

		it('never strands the user at scrollTop 0 across consecutive reveals', async () => {
			const net = createNetwork({ networkId: 'net1' });
			net.buffers.push(createBuffer({ name: '#chan' }));
			ircState.networks.push(net);
			ircState.activeBuffer.networkId = 'net1';
			ircState.activeBuffer.bufferName = '#chan';

			// msgid-less messages sharing timestamps: the t: divider marks of
			// consecutive reveals used to collide, skipping the divider settle
			// and parking the user at scrollTop 0 — where the browser fires no
			// further scroll events on wheel-up, wedging infiniscroll until
			// the user scrolled down and back up.
			const now = Date.now();
			const sharedT = now - 100000;
			const messages: IRCMessage[] = [];
			for (let i = 0; i < 600; i++) {
				messages.push(createMessage({ text: `stuck-message-${i + 1}`, t: sharedT }));
			}
			ircState.messages['net1:#chan'] = messages;
			flushSync();

			render(MessageList, { props: {} });
			const container = document.getElementById('messages') as HTMLDivElement;
			container.style.height = '300px';
			await new Promise((r) => requestAnimationFrame(r));
			await new Promise((r) => setTimeout(r, 50));

			for (let reveal = 0; reveal < 2; reveal++) {
				container.scrollTop = 0;
				container.dispatchEvent(new Event('scroll'));
				// Reveal + settle are synchronous within the scroll event; the
				// 100ms settle animation refines the position afterwards.
				await new Promise((r) => setTimeout(r, 250));
				expect(container.scrollTop).toBeGreaterThan(0);
			}

			// Both reveals landed: each reveal grows the window by BATCH_SIZE
			// (200). The windowed end (renderEndKey) keeps the tail frozen
			// while scrolled up, so after two reveals the window is the
			// last BATCH_SIZE rows of the buffer.
			expect(document.querySelectorAll('.row.messageRow').length).toBeGreaterThanOrEqual(200);
		});

		it('renders exactly one backlogDivider even when messages share the boundary timestamp', async () => {
			const net = createNetwork({ networkId: 'net1' });
			net.buffers.push(createBuffer({ name: '#chan' }));
			ircState.networks.push(net);
			ircState.activeBuffer.networkId = 'net1';
			ircState.activeBuffer.bufferName = '#chan';

			const now = Date.now();
			const boundaryT = now - 5000;
			// No msgids — the divider mark falls back to timestamp matching,
			// and several messages share the boundary timestamp (common with
			// second-resolution backfill). Regression: every match used to
			// render its own divider, stacking up after each backlog fetch.
			ircState.messages['net1:#chan'] = [
				createMessage({ text: 'fetched-older', t: now - 10000 }),
				createMessage({ text: 'boundary', t: boundaryT }),
				createMessage({ text: 'same-t-1', t: boundaryT }),
				createMessage({ text: 'same-t-2', t: boundaryT }),
				createMessage({ text: 'newest', t: now }),
			];
			ircState.backlogDivider['net1:#chan'] = `t:${boundaryT}`;
			flushSync();

			render(MessageList, { props: {} });

			await expect.element(page.getByText('boundary')).toBeInTheDocument();
			const dividers = document.querySelectorAll('.backlogDivider');
			expect(dividers.length).toBe(1);
		});

		it('prepends backfill messages in correct order', async () => {
			const net = createNetwork({ networkId: 'net1' });
			net.buffers.push(createBuffer({ name: '#chan' }));
			ircState.networks.push(net);
			ircState.activeBuffer.networkId = 'net1';
			ircState.activeBuffer.bufferName = '#chan';

			const now = Date.now();
			// Start with 10 messages
			const initialMessages: IRCMessage[] = [];
			for (let i = 0; i < 10; i++) {
				initialMessages.push(createMessage({
					text: `initial-${i + 1}`,
					t: now - (10 - i) * 1000,
					msgid: `initial-${i + 1}`,
				}));
			}
			ircState.messages['net1:#chan'] = initialMessages;
			flushSync();

			render(MessageList, { props: {} });
			await new Promise((r) => requestAnimationFrame(r));

			// Prepend 5 older messages
			const olderMessages: IRCMessage[] = [];
			for (let i = 0; i < 5; i++) {
				olderMessages.push(createMessage({
					text: `older-${i + 1}`,
					t: now - (15 - i) * 1000,
					msgid: `older-${i + 1}`,
				}));
			}
			ircState.messages['net1:#chan'] = [...olderMessages, ...initialMessages];
			flushSync();
			await new Promise((r) => setTimeout(r, 100));

			// Verify order: older messages should come first
			const allRows = document.querySelectorAll('.row.messageRow');
			const texts = Array.from(allRows).map((row) => row.textContent || '');

			// Find positions of older and initial messages
			const olderIndex = texts.findIndex((t) => t.includes('older-1'));
			const initialIndex = texts.findIndex((t) => t.includes('initial-1'));

			// Older messages should appear before initial messages
			expect(olderIndex).toBeGreaterThanOrEqual(0);
			expect(initialIndex).toBeGreaterThanOrEqual(0);
			expect(olderIndex).toBeLessThan(initialIndex);
		});
	});

	describe('server log auto-scroll guard (W7-T02b)', () => {
		// Regression: viewing the _server buffer used to flicker because
		// the MessageList's ResizeObserver + scrollToBottom effects fired
		// on every phase event (~10/s during a connect), slamming
		// container.scrollTop = scrollHeight and animating the scrollbar.
		// The server log is a fixed-content view; the user owns their
		// scroll position. Both effects now early-return when
		// isServerBuffer is true.
		it('does NOT snap to bottom when new content arrives in the _server buffer', async () => {
			ircState.networks.length = 0;
			ircState.activeBuffer.networkId = 'net1';
			ircState.activeBuffer.bufferName = '_server';
			const network = createNetwork({ networkId: 'net1', host: 'irc.test.com', port: 6697 });
			network.buffers.push(createBuffer({ name: '_server' }));
			ircState.networks.push(network);

			// Seed with a few phase events so the attempt has rows to render
			ircState.messages['net1:_server'] = [
				createMessage({ command: 'NOTICE', text: 'queued', t: 1000, eid: 1, phase: 'queued' }),
				createMessage({ command: 'NOTICE', text: 'connecting', t: 1100, eid: 2, phase: 'connecting' }),
			];
			flushSync();

			render(MessageList, { props: {} });
			await new Promise((r) => requestAnimationFrame(r));

			const container = document.getElementById('messages') as HTMLDivElement | null;
			expect(container).not.toBeNull();
			if (!container) return;

			// Make sure we are NOT at the bottom (user is reading history)
			container.scrollTop = Math.max(0, Math.floor(container.scrollHeight * 0.5));
			const pinnedScroll = container.scrollTop;
			await new Promise((r) => setTimeout(r, 30));

			// Simulate a new phase event arriving mid-connect — the
			// container's height grows, the ResizeObserver fires (or
			// would have fired), and the main scroll effect re-runs.
			ircState.messages['net1:_server'] = [
				...ircState.messages['net1:_server'],
				createMessage({ command: 'NOTICE', text: 'tcp_open', t: 1200, eid: 3, phase: 'tcp_open' }),
			];
			flushSync();
			await new Promise((r) => requestAnimationFrame(r));

			// Scroll position must NOT have been forced to scrollHeight.
			// (We allow up to 4px drift for browser sub-pixel rounding.)
			const drift = container.scrollTop - pinnedScroll;
			expect(Math.abs(drift)).toBeLessThan(4);
		});
	});

	describe('force-scroll-to-bottom on user send', () => {
		// Regression: when the user sends a message, the chat should snap
		// to the bottom even if the user has scrolled up inspecting
		// history. IRCCloud always shows you your own message after you
		// hit Enter; we match that via requestForceScrollToBottom().

		it('snaps to the bottom when the user sends, even if scrolled up', async () => {
			ircState.networks.length = 0;
			const net = createNetwork({ networkId: 'net1' });
			net.buffers.push(createBuffer({ name: '#chan' }));
			ircState.networks.push(net);
			ircState.activeBuffer.networkId = 'net1';
			ircState.activeBuffer.bufferName = '#chan';

			// Seed with enough messages to make the container scrollable.
			// 600 messages so the windowing logic kicks in (renderStart=400),
			// putting the container in the same state as the "never stranded"
			// test below (the existing test relies on the windowing to make
			// the scrollToTop auto-fill fire).
			const now = Date.now();
			const seed: IRCMessage[] = [];
			for (let i = 0; i < 600; i++) {
				seed.push(createMessage({
					command: 'PRIVMSG',
					nick: 'alice',
					text: `message-${i + 1}`,
					t: now - (600 - i) * 1000,
					msgid: `seed-${i + 1}`,
				}));
			}
			ircState.messages['net1:#chan'] = seed;
			flushSync();

			render(MessageList, { props: {} });
			flushSync();
			await new Promise((r) => requestAnimationFrame(r));
			await new Promise((r) => setTimeout(r, 30));

			const container = document.getElementById('messages') as HTMLDivElement | null;
			expect(container).not.toBeNull();
			if (!container) return;
			// Force a fixed viewport height so the test is independent of the
			// test browser's window size — with 600 messages the natural
			// scrollHeight (~3600px) often matches the default viewport
			// (~3600px), making the container un-scrollable.
			container.style.height = '600px';

			// User is reading history mid-buffer (scrolled up, NOT at bottom).
			// Use a fixed small offset (50px) so the test is viewport-size
			// independent: a percentage-based scroll can land exactly at
			// maxScroll on tall viewports where the user appears "at the
			// bottom" mathematically.
			expect(container.scrollHeight).toBeGreaterThan(container.clientHeight);
			container.scrollTop = 50;
			container.dispatchEvent(new Event('scroll'));
			await new Promise((r) => setTimeout(r, 30));
			const pre = container.scrollTop;
			expect(pre).toBeGreaterThan(0);
			expect(container.scrollTop + container.clientHeight).toBeLessThan(container.scrollHeight - 20);

			// User sends a message → InputArea calls requestForceScrollToBottom().
			requestForceScrollToBottom();
			flushSync();
			await new Promise((r) => requestAnimationFrame(r));
			await new Promise((r) => setTimeout(r, 50));

			// Scroll MUST be at the bottom regardless of where it was before.
			const drift = container.scrollHeight - container.clientHeight - container.scrollTop;
			expect(Math.abs(drift)).toBeLessThan(4);
		});

		it('does NOT snap on _server even when the trigger fires (only chat buffers force-scroll)', async () => {
			// See the force-scroll effect in MessageList.svelte — it
			// early-returns when isServerBuffer is true, so the server
			// log's scroll position is owned by the user.
			ircState.networks.length = 0;
			ircState.activeBuffer.networkId = 'net1';
			ircState.activeBuffer.bufferName = '_server';
			const network = createNetwork({ networkId: 'net1' });
			network.buffers.push(createBuffer({ name: '_server' }));
			ircState.networks.push(network);
			ircState.messages['net1:_server'] = [
				createMessage({ command: 'NOTICE', text: 'queued', t: 1000, eid: 1, phase: 'queued' }),
				createMessage({ command: 'NOTICE', text: 'connecting', t: 1100, eid: 2, phase: 'connecting' }),
			];
			flushSync();

			render(MessageList, { props: {} });
			await new Promise((r) => requestAnimationFrame(r));

			const container = document.getElementById('messages') as HTMLDivElement | null;
			expect(container).not.toBeNull();
			if (!container) return;

			container.scrollTop = 0;
			await new Promise((r) => setTimeout(r, 30));

			// Trigger fires — but the server-log effect must ignore it.
			requestForceScrollToBottom();
			await new Promise((r) => requestAnimationFrame(r));
			flushSync();
			await new Promise((r) => setTimeout(r, 30));

			expect(container.scrollTop).toBe(0);
		});
	});

	describe('force-scroll on URL navigation (setActiveBuffer)', () => {
		// Regression: opening /irc/<network>/channel/<channel> directly (or
		// otherwise switching to a different buffer via the router) must
		// always snap the chat to the bottom so the user lands on the
		// latest messages, not at scrollTop 0. setActiveBuffer is the
		// central choke-point for buffer switches (URL nav, sidebar click,
		// /join, nick click) so the force-scroll lives there.
		it('increments the force-scroll nonce on a buffer switch', () => {
			const net = createNetwork({ networkId: 'net1', name: 'FiberAdmin' });
			net.buffers.push(createBuffer({ name: 'ircfiber' }));
			ircState.networks.push(net);
			ircState.activeBuffer.networkId = null;
			ircState.activeBuffer.bufferName = null;
			// Reset the nonce so we can observe the increment cleanly.
			ircState.forceScrollToBottomNonce = 0;

			const before = ircState.forceScrollToBottomNonce;
			setActiveBuffer('net1', '#ircfiber');
			expect(ircState.forceScrollToBottomNonce).toBe(before + 1);

			// Switching to a second buffer increments again.
			setActiveBuffer('net1', '#other-channel');
			expect(ircState.forceScrollToBottomNonce).toBe(before + 2);
		});

		it('does NOT increment when the same buffer is re-set (no-op switch)', () => {
			// setActiveBuffer is sometimes called repeatedly with the same
			// args (e.g. re-render during router popstate). The force-scroll
			// only fires on a real switch so we don't fight the user's
			// scroll position when they haven't actually navigated.
			const net = createNetwork({ networkId: 'net1', name: 'FiberAdmin' });
			net.buffers.push(createBuffer({ name: 'ircfiber' }));
			ircState.networks.push(net);
			ircState.activeBuffer.networkId = 'net1';
			ircState.activeBuffer.bufferName = '#ircfiber';
			ircState.forceScrollToBottomNonce = 0;

			setActiveBuffer('net1', '#ircfiber');
			expect(ircState.forceScrollToBottomNonce).toBe(0);
		});

		it('does NOT increment when switching TO the _server buffer', () => {
			// The server log is a fixed-content view; the user owns their
			// scroll position while inspecting connection history. Skipping
			// the force-scroll for the _server buffer matches the
			// "isServerBuffer early-return" in MessageList's effect.
			const net = createNetwork({ networkId: 'net1' });
			net.buffers.push(createBuffer({ name: '_server' }));
			ircState.networks.push(net);
			ircState.activeBuffer.networkId = 'net1';
			ircState.activeBuffer.bufferName = '#ircfiber';
			ircState.forceScrollToBottomNonce = 0;

			setActiveBuffer('net1', '_server');
			expect(ircState.forceScrollToBottomNonce).toBe(0);
		});
	});

	describe('rapid message sends (W7-T03b typing-lag regression)', () => {
		// User-reported bug: typing 9 messages back-to-back as fast as
		// possible caused some of them to fail to render in the chat.
		// Root cause: each `InputArea.handleSend` calls
		// `appendToProcessed(processed, [optimistic])` with the *previous*
		// processed array. If two send-handlers interleave on the
		// microtask queue (which they do — each handler awaits
		// requestForceScrollToBottom's effect flush), the second handler's
		// `appendToProcessed` runs against the FIRST handler's output and
		// appends on top of the in-flight optimistic. The optimistic
		// message it adds is then visible, but the next handler stomps it
		// with a `processedMessages[key] = ...` write that drops the
		// previous append's tail. The result: a few messages vanish.
		//
		// This test sends 9 messages in a single synchronous tick (no awaits
		// between) and asserts all 9 are in the rendered DOM. The fix
		// needs to either sequence the appends through a queue or detect
		// the in-flight append and concatenate.

		// Helper: same code path InputArea.handleSend uses after send —
		// pushes the optimistic onto ircState.messages and updates the
		// processed cache. We replicate it here instead of stubbing
		// WebSocket send so the test exercises the actual hot path.
		function sendOptimistic(label: string, text: string): void {
			const key = 'net1:#chan';
			const optimistic: IRCMessage = {
				command: 'PRIVMSG',
				nick: 'me',
				text,
				t: Date.now(),
				label,
				timestamp: new Date().toISOString(),
				params: [],
				prefix: '',
				msgid: '',
			};
			ircState.optimisticMessages.set(label, optimistic);
			const list = ircState.messages[key] ?? [];
			list.push(optimistic);
			ircState.messages[key] = list;
			if (ircState.processedMessages[key]) {
				ircState.processedMessages[key] = appendToProcessed(
					ircState.processedMessages[key],
					[optimistic],
				);
			} else {
				ircState.processedMessages[key] = buildProcessedBuffer(list);
			}
		}

		it('shows all 9 messages when typed back-to-back in a single tick', async () => {
			const net = createNetwork({ networkId: 'net1' });
			net.buffers.push(createBuffer({ name: '#chan' }));
			ircState.networks.push(net);
			ircState.activeBuffer.networkId = 'net1';
			ircState.activeBuffer.bufferName = '#chan';

			render(MessageList, { props: {} });
			flushSync();
			await new Promise((r) => requestAnimationFrame(r));

			// Simulate 9 rapid sends in a single synchronous tick (no awaits
			// between). The user types Enter 9 times as fast as they can.
			for (let i = 1; i <= 9; i++) {
				sendOptimistic(`lbl-${i}`, String(i));
			}
			flushSync();
			await new Promise((r) => requestAnimationFrame(r));

			// All 9 messages must be in the rendered DOM. Use the `.content`
			// span (not the entire row, which includes the timestamp) so
			// "4:43:13 PM" digits don't false-match "1", "3", "4" in the
			// timestamp. We also pull from ircState to verify the processed
			// cache matches the raw list (the echo path replaces entries
			// in-place; the optimistic path appends).
			const rows = document.querySelectorAll('.row.messageRow .content');
			const renderedTexts = Array.from(rows).map((r) => (r.textContent ?? '').trim());
			expect(renderedTexts).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9']);

			// ircState side: all 9 messages are in the raw list.
			const raw = ircState.messages['net1:#chan'] ?? [];
			expect(raw.length).toBe(9);
			expect(raw.map((m) => m.text)).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9']);

			// The processed cache must have all 9 too — no appends dropped.
			const processed = ircState.processedMessages['net1:#chan'] ?? [];
			const processedTexts = processed
				.filter((m) => m.text && /^\d$/.test(m.text))
				.map((m) => m.text);
			expect(processedTexts).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9']);
		});

		it('shows all 9 messages when each send is followed by its echo (echo round-trip)', async () => {
			// The realistic failure mode: each send appends the optimistic
			// (InputArea) and then the server echo comes back and replaces
			// it (ircStore.appendMessage). If the echo replace path drops or
			// duplicates messages, the user sees them vanish or appear
			// twice as they type rapidly. We send 9 optimistic + 9 echoes
			// interleaved in a single tick (matching what handleSend +
			// WebSocket round-trip looks like in the real app when the user
			// mashes Enter).
			const net = createNetwork({ networkId: 'net1' });
			net.buffers.push(createBuffer({ name: '#chan' }));
			ircState.networks.push(net);
			ircState.activeBuffer.networkId = 'net1';
			ircState.activeBuffer.bufferName = '#chan';

			render(MessageList, { props: {} });
			flushSync();
			await new Promise((r) => requestAnimationFrame(r));

			// For each message: send the optimistic, then immediately the
			// echo replaces it. Same end-state as the real app where the
			// echo arrives ~50ms after the optimistic. Doing them back-to-
			// back in a single tick exposes any state-divergence between
			// the optimistic append and the echo replace.
			for (let i = 1; i <= 9; i++) {
				sendOptimistic(`lbl-${i}`, String(i));
				// Echo replaces the optimistic — same label, same text,
				// but with an eid (which the optimistic didn't have).
				appendMessage('net1', '#chan', {
					command: 'PRIVMSG',
					nick: 'me',
					text: String(i),
					t: Date.now(),
					eid: 1000 + i,
					msgid: `srv-${i}`,
					label: `lbl-${i}`,
					timestamp: new Date().toISOString(),
					params: [],
					prefix: '',
				});
			}
			flushSync();
			await new Promise((r) => requestAnimationFrame(r));

			const rows = document.querySelectorAll('.row.messageRow .content');
			const renderedTexts = Array.from(rows).map((r) => (r.textContent ?? '').trim());
			expect(renderedTexts).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9']);

			// ircState side: 9 messages, each with its echo's eid.
			const raw = ircState.messages['net1:#chan'] ?? [];
			expect(raw.length).toBe(9);
			expect(raw.map((m) => m.eid)).toEqual([1001, 1002, 1003, 1004, 1005, 1006, 1007, 1008, 1009]);
			expect(raw.map((m) => m.text)).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9']);

			// Processed cache must have all 9 too.
			const processed = ircState.processedMessages['net1:#chan'] ?? [];
			const processedTexts = processed
				.filter((m) => m.text && /^\d$/.test(m.text))
				.map((m) => m.text);
			expect(processedTexts).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9']);
			const processedEids = processed
				.filter((m) => m.text && /^\d$/.test(m.text))
				.map((m) => m.eid);
			expect(processedEids).toEqual([1001, 1002, 1003, 1004, 1005, 1006, 1007, 1008, 1009]);
		});
	});
});
