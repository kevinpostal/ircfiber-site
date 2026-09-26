// Pixel-level proof that the compose status row never reflows the compose
// area.
//
// The strip used to be `{#if typingText}` inside .bufferinputcell, so every
// `+typing=active` / `+typing=done` / 6.5s-expiry cycle changed that cell's
// height, shrank the .messages viewport and tripped MessageList's
// ResizeObserver re-pin — the message list visibly jumped up and down.
//
// An earlier fix instead floated the pill over the viewport with
// `position: absolute`, which clipped the last message. Neither design may
// come back.
//
// It is now a status line whose height is pinned at 25px in CSS
// (_chatInput.scss .composeStatusRow) and which is never empty: the left
// chip carries the transient label (typing, or an in-flight upload) while
// the right end always carries the network's last measured lag and the
// clock. Only opacity and text change across states.
//
// This lives in its own file because it needs the real stylesheet injected
// globally (same convention as MessageRow.statusStyles.test.ts), which
// InputArea.test.ts deliberately does not do.
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import { flushSync } from 'svelte';
import InputArea from './InputArea.svelte';
import { createNetwork, createBuffer } from '../test/factories';
import { ircState, bufferInputText, lastSentMessages, setTyping, clearTyping, resetTypingState } from '../stores/ircStore.svelte';
import { globalPrefs, DEFAULT_PREFS } from '../stores/preferences.svelte';
import { recentHighlightersCache } from '../lib/tabCompletion';
import { uploadState } from '../stores/uploadStore.svelte';
import { mediaDock, dockVideo, closeDock } from '../stores/mediaDock.svelte';
// The reserved-band geometry under test lives here.
import '../styles/components/_chatInput.scss';

vi.mock('/src/stores/api', () => ({
  // uploadFlow imports these; a factory mock must name every export the
  // module graph pulls in or the whole suite fails to collect.
  convertUploadToGif: vi.fn(async () => ({ id: 'gif1', url: '/uploads/x.gif' })),
  startGifConversion: vi.fn(async () => 'job1'),
  getGifJob: vi.fn(async () => ({ state: 'done', percent: 100, frame: 0, fps: 0, speed: 0, durationMs: 0, outTimeMs: 0, elapsedMs: 0, etaMs: 0 })),
  reconnectNetwork: vi.fn(async () => undefined),
  clearBacklog: vi.fn(async () => undefined),
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
  normalizeMessage: vi.fn((m: unknown) => m),
}));

function resetState(): void {
	ircState.networks.length = 0;
	ircState.activeBuffer.networkId = null;
	ircState.activeBuffer.bufferName = null;
	ircState.messages = {};
	ircState.processedMessages = {};
	resetTypingState();
	uploadState.active = [];
	bufferInputText.clear();
	for (const k of Object.keys(lastSentMessages)) delete lastSentMessages[k];
	Object.assign(globalPrefs, DEFAULT_PREFS);
	closeDock();
	recentHighlightersCache.clear();
}

beforeEach(() => {
	resetState();
	vi.clearAllMocks();
});

describe('InputArea compose status row geometry', () => {
	// Nothing here asserts on sends; these only keep the component off the
	// real wsConnection helpers.
	const noSend: (...args: any[]) => any = () => undefined;

	it('keeps the status row at a constant 25px across idle, typing and uploading', async () => {
		const net = createNetwork({ networkId: 'net1', currentNick: 'tester', connected: true, lagMs: 41 });
		net.buffers.push(createBuffer({ name: '#general' }));
		ircState.networks.push(net);
		ircState.activeBuffer.networkId = 'net1';
		ircState.activeBuffer.bufferName = '#general';
		render(InputArea, { props: { onSendMessage: noSend, onSendRaw: noSend } });
		flushSync();

		const cell = document.querySelector('.bufferinputcell') as HTMLElement;
		const row = document.querySelector('.bufferinputcell .composeStatusRow') as HTMLElement;
		expect(row).not.toBeNull();
		const idleHeight = cell.getBoundingClientRect().height;
		// Exact height doubles as the "stylesheet actually loaded" guard.
		expect(Math.round(row.getBoundingClientRect().height)).toBe(25);
		expect(idleHeight).toBeGreaterThan(0);
		// Idle row is not dead space: the clock renders with no typer.
		expect((row.querySelector('.composeStatusClock')?.textContent ?? '').length).toBeGreaterThan(0);

		setTyping('net1', '#general', 'Alice');
		flushSync();
		expect(page.getByText('Alice is typing').query()).not.toBeNull();
		expect(cell.getBoundingClientRect().height).toBe(idleHeight);

		// A long upload label must not grow the row either.
		uploadState.active.push({ id: 1, filename: 'a-very-long-filename.png', size: 1000, progress: 40, status: 'uploading' });
		flushSync();
		expect(page.getByText('Uploading 1 file — 40%').query()).not.toBeNull();
		expect(cell.getBoundingClientRect().height).toBe(idleHeight);

		uploadState.active.length = 0;
		clearTyping('net1', '#general', 'Alice');
		flushSync();
		expect(cell.getBoundingClientRect().height).toBe(idleHeight);
	});

	it('the minimized mini-player chip joins the row without changing its height', () => {
		const net = createNetwork({ networkId: 'net1', currentNick: 'tester', connected: true, lagMs: 41 });
		net.buffers.push(createBuffer({ name: '#general' }));
		ircState.networks.push(net);
		ircState.activeBuffer.networkId = 'net1';
		ircState.activeBuffer.bufferName = '#general';
		render(InputArea, { props: { onSendMessage: noSend, onSendRaw: noSend } });
		flushSync();

		const cell = document.querySelector('.bufferinputcell') as HTMLElement;
		const row = document.querySelector('.bufferinputcell .composeStatusRow') as HTMLElement;
		const idleHeight = cell.getBoundingClientRect().height;
		expect(row.querySelector('.mediaDockChip')).toBeNull();

		dockVideo({ videoId: 'sHuu-kKD0Lc', startSeconds: 83, origin: null });
		mediaDock.minimized = true;
		flushSync();
		const chip = row.querySelector('.mediaDockChip') as HTMLElement;
		expect(chip).not.toBeNull();
		expect(chip.getBoundingClientRect().height).toBeLessThanOrEqual(21);
		expect(chip.textContent).toContain('1:23');
		expect(Math.round(row.getBoundingClientRect().height)).toBe(25);
		expect(cell.getBoundingClientRect().height).toBe(idleHeight);

		// Coexists with the typing pill: chip left, pill to its right, same height.
		setTyping('net1', '#general', 'Alice');
		flushSync();
		const pill = row.querySelector('.typing-pill') as HTMLElement;
		expect(page.getByText('Alice is typing').query()).not.toBeNull();
		expect(pill.getBoundingClientRect().left).toBeGreaterThanOrEqual(chip.getBoundingClientRect().right);
		expect(cell.getBoundingClientRect().height).toBe(idleHeight);

		// Chip × closes the player and leaves the row.
		(chip.querySelector('.mediaDockChip__close') as HTMLButtonElement).click();
		flushSync();
		expect(mediaDock.video).toBeNull();
		expect(row.querySelector('.mediaDockChip')).toBeNull();
		expect(cell.getBoundingClientRect().height).toBe(idleHeight);
	});
});
