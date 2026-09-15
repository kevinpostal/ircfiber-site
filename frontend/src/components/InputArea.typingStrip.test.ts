// Pixel-level proof that the typing strip never reflows the compose area.
//
// The strip used to be `{#if typingText}` inside .bufferinputcell, so every
// `+typing=active` / `+typing=done` / 6.5s-expiry cycle changed that cell's
// height, shrank the .messages viewport and tripped MessageList's
// ResizeObserver re-pin — the message list visibly jumped up and down. It is
// now a permanently reserved constant-height row (_chatInput.scss
// .typingcell/.typing-pill); only opacity and label text change.
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
	bufferInputText.clear();
	for (const k of Object.keys(lastSentMessages)) delete lastSentMessages[k];
	Object.assign(globalPrefs, DEFAULT_PREFS);
	recentHighlightersCache.clear();
}

beforeEach(() => {
	resetState();
	vi.clearAllMocks();
});

describe('InputArea typing strip geometry', () => {
	// Nothing here asserts on sends; these only keep the component off the
	// real wsConnection helpers.
	const noSend: (...args: any[]) => any = () => undefined;

	it('reserves the typing strip so .bufferinputcell height is identical idle vs typing', async () => {
		const net = createNetwork({ networkId: 'net1', currentNick: 'tester' });
		net.buffers.push(createBuffer({ name: '#general' }));
		ircState.networks.push(net);
		ircState.activeBuffer.networkId = 'net1';
		ircState.activeBuffer.bufferName = '#general';
		render(InputArea, { props: { onSendMessage: noSend, onSendRaw: noSend } });
		flushSync();

		const cell = document.querySelector('.bufferinputcell') as HTMLElement;
		const strip = document.querySelector('.bufferinputcell .typingcell') as HTMLElement;
		const idleHeight = cell.getBoundingClientRect().height;
		expect(strip).not.toBeNull();
		// The band must already occupy its full height while idle — otherwise
		// the stylesheet did not load and the equality below is vacuous.
		expect(strip.getBoundingClientRect().height).toBeGreaterThan(15);
		expect(idleHeight).toBeGreaterThan(0);

		setTyping('net1', '#general', 'Alice');
		flushSync();

		expect(page.getByText('Alice is typing').query()).not.toBeNull();
		expect(cell.getBoundingClientRect().height).toBe(idleHeight);

		// …and back down again: the whole active/done cycle is height-neutral.
		clearTyping('net1', '#general', 'Alice');
		flushSync();

		expect(cell.getBoundingClientRect().height).toBe(idleHeight);
	});
});
