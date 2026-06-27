import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page, userEvent } from 'vitest/browser';
import { flushSync } from 'svelte';
import MessageList from './MessageList.svelte';
import { createMessage, createNetwork, createBuffer } from '../test/factories';
import { ircState } from '../stores/ircStore.svelte';
import { clearedAtMap } from '../stores/preferences.svelte';
import type { IRCMessage } from '../types';

function resetState(): void {
	ircState.networks.length = 0;
	ircState.activeBuffer.networkId = null;
	ircState.activeBuffer.bufferName = null;
	ircState.messages = {};
	ircState.backlogDivider = {};
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
});
