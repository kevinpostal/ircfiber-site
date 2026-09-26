/* The upload confirm dialog (#fileUploadContainer) used to be a fixed 550px
 * box centred with `margin-left: -275px`. On a phone that put its left 80px
 * off-screen — and the phone breakpoint's `overflow-x: hidden` clipped it —
 * so an iPhone user could pick a photo but only ever see a sliver of the
 * Upload button. These assertions need the real cascade, so this file loads
 * the app stylesheet and runs in the `client` (chromium) project.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import { tick } from 'svelte';
import UploadDialog from './UploadDialog.svelte';
import { uploadState, trackUpload } from '../stores/uploadStore.svelte';
import { ircState } from '../stores/ircStore.svelte';
import { createNetwork, createBuffer } from '../test/factories';
import '../app.css';
import '../styles/main.scss';

// Same factory mock as upload.e2e.test.ts: it must name every export the
// module graph pulls in or the file fails to collect.
vi.mock('/src/stores/api', () => ({
	convertUploadToGif: vi.fn(async () => ({ id: 'gif1', url: '/uploads/x.gif' })),
	startGifConversion: vi.fn(async () => 'job1'),
	getGifJob: vi.fn(async () => ({ state: 'done', percent: 100, frame: 0, fps: 0, speed: 0, durationMs: 0, outTimeMs: 0, elapsedMs: 0, etaMs: 0 })),
	reconnectNetwork: vi.fn(async () => undefined),
	clearBacklog: vi.fn(async () => undefined),
	disconnectNetwork: vi.fn(async () => undefined),
	fetchMe: vi.fn(async () => ({ username: 'tester' })),
	fetchHealth: vi.fn(async () => ({ status: 'healthy', services: {} })),
	loadHistory: vi.fn(async () => []),
	joinChannel: vi.fn(async () => undefined),
	addNetwork: vi.fn(async () => undefined),
	updateNetwork: vi.fn(async () => undefined),
	deleteNetwork: vi.fn(async () => undefined),
	archiveChannel: vi.fn(async () => undefined),
	unarchiveChannel: vi.fn(async () => undefined),
	normalizeMessage: vi.fn((m: unknown) => m),
	createIrcArtSave: vi.fn(async () => ({ id: 'test' })),
	updateIrcArtSave: vi.fn(async () => ({})),
	deleteIrcArtSave: vi.fn(async () => ({})),
	fetchIrcArtSavesOffset: vi.fn(async () => ({ entries: [], total: 0 })),
	fetchArchiveNames: vi.fn(async () => ({ names: [] })),
	fetchUploads: vi.fn(async () => []),
	fetchUploadsOffset: vi.fn(async () => ({ entries: [], total: 0 })),
	fetchPastebinsOffset: vi.fn(async () => ({ entries: [], total: 0 })),
	createPastebin: vi.fn(async () => ({ id: 'test' })),
}));

function openDialog(): void {
	const net = createNetwork({ networkId: 'net1', name: 'TestNet', connected: true });
	net.buffers.push(createBuffer({ name: '#test', type: 'channel', isJoined: true }));
	ircState.networks.push(net);
	ircState.activeBuffer.networkId = 'net1';
	ircState.activeBuffer.bufferName = '#test';
	const u = trackUpload('IMG_0001.jpeg', 1234);
	uploadState.dialog = { mode: 'single', uploads: [u], message: '' };
}

function uploadButton(): HTMLButtonElement {
	const btn = Array.from(document.querySelectorAll<HTMLButtonElement>('#fileUploadContainer button'))
		.find((b) => b.textContent?.trim() === 'Upload');
	if (!btn) throw new Error('Upload button not rendered');
	return btn;
}

describe('upload confirm dialog on a phone', () => {
	beforeEach(() => {
		document.body.innerHTML = '';
		uploadState.dialog = null;
	});
	afterEach(async () => {
		uploadState.dialog = null;
		await page.viewport(1280, 800);
	});

	for (const [label, w, h] of [['iPhone 15', 393, 659], ['iPhone SE', 320, 568]] as const) {
		it(`fits the ${label} viewport with the Upload button fully on screen`, async () => {
			await page.viewport(w, h);
			openDialog();
			render(UploadDialog, { props: { onConfirm: vi.fn(), onCancel: vi.fn() } });
			await tick();

			const box = (document.querySelector('#fileUploadContainer') as HTMLElement).getBoundingClientRect();
			expect(box.left).toBeGreaterThanOrEqual(0);
			expect(box.right).toBeLessThanOrEqual(w);

			const btn = uploadButton().getBoundingClientRect();
			expect(btn.left).toBeGreaterThanOrEqual(0);
			expect(btn.right).toBeLessThanOrEqual(w);
			expect(btn.bottom).toBeLessThanOrEqual(h);

			// No horizontal overflow: nothing to pan to, nothing clipped.
			expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(w);

			// The button is what actually receives the tap at its centre.
			const hit = document.elementFromPoint(btn.left + btn.width / 2, btn.top + btn.height / 2);
			expect(uploadButton().contains(hit)).toBe(true);
		});
	}

	it('keeps the desktop width on a wide viewport', async () => {
		await page.viewport(1280, 800);
		openDialog();
		render(UploadDialog, { props: { onConfirm: vi.fn(), onCancel: vi.fn() } });
		await tick();
		const box = (document.querySelector('#fileUploadContainer') as HTMLElement).getBoundingClientRect();
		expect(Math.round(box.width)).toBe(550);
		expect(Math.round(box.left + box.width / 2)).toBe(640);
	});
});
