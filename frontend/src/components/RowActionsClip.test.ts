/* The row-actions toolbar — Reply · React · More plus the quick-reaction
 * strip — is 26px tall and hangs off a 16px grouped chat row, so it paints,
 * and has to stay clickable, outside its row's box. `.row.messageRow` carries
 * `contain: layout paint` so off-screen ANSI-art rows can be skipped
 * (src/app.css); paint containment clipped the toolbar to the row, which cut
 * the top half off every emoji and stopped that band from hit-testing. The
 * assertions below need the real cascade and real layout, so this file loads
 * the app stylesheet and runs in the `client` (chromium) project.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page, userEvent } from 'vitest/browser';
import { flushSync } from 'svelte';
import MessageRow from './MessageRow.svelte';
import { createMessage, createNetwork, createBuffer } from '../test/factories';
import { ircState } from '../stores/ircStore.svelte';
import '../app.css';
import '../styles/main.scss';

vi.mock('/src/stores/wsConnection.svelte.ts', () => ({
	sendRaw: vi.fn(),
	sendJson: vi.fn(),
	sendMessage: vi.fn(),
	setMaxEid: vi.fn(),
}));

function activeChannel(): void {
	const net = createNetwork({ networkId: 'net1', currentNick: 'me', capabilities: new Set(['message-tags']) });
	net.buffers.push(createBuffer({ name: '#chan', isJoined: true }));
	ircState.networks.push(net);
	ircState.activeBuffer.networkId = 'net1';
	ircState.activeBuffer.bufferName = '#chan';
}

describe('row actions toolbar', () => {
	beforeEach(async () => {
		ircState.networks.length = 0;
		ircState.activeBuffer.networkId = null;
		ircState.activeBuffer.bufferName = null;
		ircState.messages = {};
		ircState.processedMessages = {};
		ircState.messageActions = null;
		document.body.innerHTML = '';
		// Row density is what makes the toolbar overhang: the phone
		// breakpoint (styles/layout/_responsive.scss) pads rows to 24px, the
		// desktop one the app actually ships leaves them at 16px.
		await page.viewport(1280, 800);
		// The toolbar overhangs the *top* of its row, so leave room above it —
		// outside the viewport nothing hit-tests.
		document.body.style.paddingTop = '80px';
	});
	afterEach(() => {
		document.body.style.paddingTop = '';
	});

	it('stays clickable where it is drawn, above the row it hangs on', async () => {
		activeChannel();
		const msg = createMessage({ nick: 'alice', text: 'hello', msgid: 'dc-1' });
		ircState.messages['net1:#chan'] = [msg];
		flushSync();
		render(MessageRow, { props: { msg, isSameAuthor: true } });

		const row = document.querySelector('.row.messageRow') as HTMLElement;
		const pill = row.querySelector('.rowActions') as HTMLElement;
		// Only a real pointer sets :hover, which is what reveals the toolbar.
		await userEvent.hover(row);
		await expect.poll(() => getComputedStyle(pill).visibility).toBe('visible');

		(row.querySelector('.rowAction.react') as HTMLButtonElement).click();
		flushSync();
		const strip = row.querySelector('.reactStrip') as HTMLElement;
		await expect.poll(() => strip.getBoundingClientRect().width > 150).toBe(true);

		const rowTop = row.getBoundingClientRect().top;
		const pillBox = pill.getBoundingClientRect();
		// Without an overhang there is nothing for containment to clip and the
		// assertion below would pass on a broken stylesheet too.
		expect(pillBox.top).toBeLessThan(rowTop);

		// Probe the toolbar one pixel above the row's clip edge, over the quick
		// reactions: clipped, this lands on the row's own text instead.
		const thumb = row.querySelector('.quickReaction[aria-label="React 👍"]') as HTMLElement;
		const thumbBox = thumb.getBoundingClientRect();
		const y = Math.min(pillBox.top + 1, rowTop - 1);
		const hit = document.elementFromPoint(thumbBox.left + thumbBox.width / 2, y);
		expect(hit?.closest('.rowActions')).toBe(pill);

		// The emoji buttons themselves overhang at this density, so their own
		// top edge must hit them and not the row underneath.
		expect(thumbBox.top).toBeLessThan(rowTop);
		const thumbHit = document.elementFromPoint(thumbBox.left + thumbBox.width / 2, thumbBox.top + 2);
		expect(thumbHit?.closest('.quickReaction')).toBe(thumb);
	});
});
