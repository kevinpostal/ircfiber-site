/* IRCCloud renders a chat line whose body is nothing but emoji much larger
 * — `renderChat` pushes `only_emoji` and
 * `.emoji-big .only_emoji .content .emojinative { font-size: 32px;
 * line-height: 36px }` scales it (common-002a6024.css @751601). Ours is the
 * `onlyEmoji` row class plus `.row.messageRow.onlyEmoji .longMessageContent`
 * in src/app.css, gated on globalPrefs.enlargeEmoji.
 *
 * These assertions need the real cascade and real layout (computed sizes,
 * row height), so this file loads the app stylesheets and runs in the
 * `client` (chromium) project — same harness as RowActionsClip.test.ts.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { flushSync } from 'svelte';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';
import MessageRow from './MessageRow.svelte';
import { createMessage } from '../test/factories';
import { globalPrefs, DEFAULT_PREFS } from '../stores/preferences.svelte';
import '../app.css';
import '../styles/main.scss';

vi.mock('/src/stores/wsConnection.svelte.ts', () => ({
  sendRaw: vi.fn(),
  sendJson: vi.fn(),
  sendMessage: vi.fn(),
  setMaxEid: vi.fn(),
}));

// setup.client.ts resets ircState only — preferences are module-level state
// too, and every test here depends on enlargeEmoji's default. The viewport
// matters as much: styles/layout/_responsive.scss bumps rows to 15px/1.45
// at the phone breakpoint, and the sizes asserted below are the desktop
// ones the app actually ships (same reason RowActionsClip.test.ts pins it).
beforeEach(async () => {
	Object.assign(globalPrefs, DEFAULT_PREFS);
	document.body.innerHTML = '';
	await page.viewport(1280, 800);
});

function el(sel: string): HTMLElement {
	const found = document.querySelector(sel) as HTMLElement | null;
	if (!found) throw new Error(`no element matched ${sel}`);
	return found;
}

function fontSize(sel: string): string {
	return getComputedStyle(el(sel)).fontSize;
}

describe('emoji-only message rows', () => {
	it('renders an emoji-only body at 32px', () => {
		render(MessageRow, { props: { msg: createMessage({ nick: 'alice', text: '🤔' }) } });

		expect(document.querySelector('.row.messageRow.onlyEmoji')).not.toBeNull();
		expect(fontSize('.onlyEmoji .longMessageContent')).toBe('32px');
	});

	it('leaves the body at 14px when enlargeEmoji is off', () => {
		globalPrefs.enlargeEmoji = false;
		render(MessageRow, { props: { msg: createMessage({ nick: 'alice', text: '🤔' }) } });

		expect(document.querySelector('.onlyEmoji')).toBeNull();
		expect(fontSize('.row.messageRow .longMessageContent')).toBe('14px');
	});

	it('collapses a rendered row live when the preference is switched off', () => {
		render(MessageRow, { props: { msg: createMessage({ nick: 'alice', text: '🤔' }) } });
		expect(fontSize('.onlyEmoji .longMessageContent')).toBe('32px');

		globalPrefs.enlargeEmoji = false;
		flushSync();

		expect(document.querySelector('.onlyEmoji')).toBeNull();
		expect(fontSize('.row.messageRow .longMessageContent')).toBe('14px');
	});

	it('leaves a body with words in it alone', () => {
		render(MessageRow, { props: { msg: createMessage({ nick: 'alice', text: 'hello 🤔' }) } });

		expect(document.querySelector('.onlyEmoji')).toBeNull();
		expect(fontSize('.row.messageRow .longMessageContent')).toBe('14px');
	});

	it('makes the emoji-only row taller than an ordinary one', () => {
		render(MessageRow, { props: { msg: createMessage({ nick: 'alice', text: '🤔' }) } });
		render(MessageRow, { props: { msg: createMessage({ nick: 'bob', text: 'hello 🤔' }) } });

		const rows = document.querySelectorAll('.row.messageRow');
		expect(rows.length).toBe(2);
		const jumbo = rows[0].getBoundingClientRect().height;
		const plain = rows[1].getBoundingClientRect().height;
		expect(rows[0].classList.contains('onlyEmoji')).toBe(true);
		expect(jumbo).toBeGreaterThan(plain);
	});

	it('scales an ACTION body without scaling its author link', () => {
		render(MessageRow, { props: { msg: createMessage({ nick: 'alice', text: '🤔', type: 'action' }) } });

		expect(document.querySelector('.row.messageRow.onlyEmoji')).not.toBeNull();
		expect(fontSize('.onlyEmoji .longMessageContent')).toBe('32px');
		// The ACTION arm puts the avatar, me-dash and author link inside
		// `.content`, which is why the CSS targets `.longMessageContent`.
		expect(fontSize('.onlyEmoji .author')).toBe('14px');
	});
});
