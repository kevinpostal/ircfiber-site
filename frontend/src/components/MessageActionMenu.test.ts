import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { flushSync } from 'svelte';
import MessageActionMenu from './MessageActionMenu.svelte';
import { createMessage, createNetwork, createBuffer } from '../test/factories';
import { ircState, recordSentMessage, lastSentMessages, type MessageActionsTarget } from '../stores/ircStore.svelte';
import { globalPrefs, DEFAULT_PREFS } from '../stores/preferences.svelte';
import type { IRCMessage } from '../types';

vi.mock('/src/stores/wsConnection.svelte.ts', () => ({
  sendRaw: vi.fn(),
  sendJson: vi.fn(),
  sendMessage: vi.fn(),
  setMaxEid: vi.fn(),
}));

import { sendRaw } from '/src/stores/wsConnection.svelte.ts';

function setup(caps: string[]): void {
	const net = createNetwork({ networkId: 'net1', currentNick: 'me', capabilities: new Set(caps) });
	net.buffers.push(createBuffer({ name: '#chan', isJoined: true }));
	ircState.networks.push(net);
	ircState.activeBuffer.networkId = 'net1';
	ircState.activeBuffer.bufferName = '#chan';
}

/** Opens the menu for `msg` the way a row does: publish the target, mount once. */
function open(msg: IRCMessage, sheet = false): MessageActionsTarget {
	ircState.messages['net1:#chan'] = [msg];
	const target: MessageActionsTarget = { networkId: 'net1', bufferName: '#chan', msg, x: 100, y: 100, sheet, rowEl: null };
	ircState.messageActions = target;
	flushSync();
	render(MessageActionMenu, { props: { target } });
	return target;
}

const item = (cls: string) => document.querySelector(`.contextMenu__item.${cls}`) as HTMLButtonElement | null;

beforeEach(() => {
	ircState.networks.length = 0;
	ircState.activeBuffer.networkId = null;
	ircState.activeBuffer.bufferName = null;
	ircState.messages = {};
	ircState.processedMessages = {};
	ircState.replyTarget = null;
	ircState.reactTarget = null;
	ircState.messageActions = null;
	ircState.editRequest = null;
	for (const k of Object.keys(lastSentMessages)) delete lastSentMessages[k];
	Object.assign(globalPrefs, DEFAULT_PREFS);
	globalPrefs.featureFlags.editMessage.enabled = true;
	document.body.innerHTML = '';
	vi.clearAllMocks();
});

describe('MessageActionMenu — Edit', () => {
	it('offers Edit only on our own last-sent message when draft/edit-message is negotiated', async () => {
		setup(['message-tags', 'draft/edit-message']);
		// A plain send records only the label; the echoed row carries it.
		recordSentMessage('net1', '#chan', { label: 'l1', body: 'hi' });
		open(createMessage({ nick: 'me', text: 'hi', msgid: 'dc-1', label: 'l1' }));

		expect(item('edit')).toBeInTheDocument();
		item('edit')!.click();
		flushSync();

		expect(ircState.editRequest).toEqual({
			networkId: 'net1', bufferName: '#chan', label: 'l1', body: 'hi', msgid: undefined, eid: undefined,
		});
		expect(ircState.messageActions).toBeNull();
	});

	it('matches by msgid after an edit recorded it', async () => {
		setup(['message-tags', 'draft/edit-message']);
		recordSentMessage('net1', '#chan', { label: 'l1', body: 'hi again', msgid: 'dc-1' });
		open(createMessage({ nick: 'me', text: 'hi again', msgid: 'dc-1' }));
		expect(item('edit')).toBeInTheDocument();
	});

	it('hides Edit on an earlier own message, on someone else\'s message, and without the cap', async () => {
		setup(['message-tags', 'draft/edit-message']);
		recordSentMessage('net1', '#chan', { label: 'l2', body: 'later' });
		open(createMessage({ nick: 'me', text: 'hi', msgid: 'dc-1', label: 'l1' }));
		expect(item('edit')).toBeNull();

		document.body.innerHTML = '';
		open(createMessage({ nick: 'alice', text: 'later', msgid: 'dc-2', label: 'l2' }));
		expect(item('edit')).toBeNull();

		document.body.innerHTML = '';
		ircState.networks[0].capabilities = new Set(['message-tags']);
		open(createMessage({ nick: 'me', text: 'later', msgid: 'dc-2', label: 'l2' }));
		expect(item('edit')).toBeNull();
	});
});

describe('MessageActionMenu — Delete', () => {
	it('is gated on draft/message-redaction and sends REDACT only after confirmation', async () => {
		setup(['message-tags', 'draft/message-redaction']);
		// Not just own rows: the server decides (FAIL REDACT REDACT_FORBIDDEN).
		open(createMessage({ nick: 'alice', text: 'hello', msgid: 'dc-1' }));

		const del = item('delete')!;
		expect(del.textContent).toBe('Delete…');
		del.click();
		flushSync();
		expect(del.textContent).toBe('Confirm delete');
		expect(sendRaw).not.toHaveBeenCalled();
		expect(ircState.messageActions).not.toBeNull();

		del.click();
		flushSync();
		expect(sendRaw).toHaveBeenCalledWith('net1', 'REDACT #chan dc-1');
		expect(ircState.messageActions).toBeNull();
	});

	it('is absent when the network did not negotiate the cap', async () => {
		setup(['message-tags']);
		open(createMessage({ nick: 'me', text: 'hello', msgid: 'dc-1' }));
		expect(item('delete')).toBeNull();
		expect(item('reply')).toBeInTheDocument();
		expect(item('copy')).toBeInTheDocument();
	});
});

describe('MessageActionMenu — Reply and reactions', () => {
	it('Reply sets the store reply target and closes', async () => {
		setup([]);
		open(createMessage({ nick: 'alice', text: 'the original', msgid: 'dc-1' }));
		item('reply')!.click();
		flushSync();
		expect(ircState.replyTarget).toEqual({
			networkId: 'net1', bufferName: '#chan', msgid: 'dc-1',
			nick: 'alice', excerpt: 'the original',
		});
		expect(ircState.messageActions).toBeNull();
	});

	it('a quick reaction sends the TAGMSG and closes', async () => {
		setup([]);
		open(createMessage({ nick: 'alice', text: 'hello', msgid: 'dc-1' }));
		(document.querySelector('.messageActionMenu .quickReaction[aria-label="React 👍"]') as HTMLButtonElement).click();
		flushSync();
		expect(sendRaw).toHaveBeenCalledWith('net1', '@+reply=dc-1;+draft/react=👍 TAGMSG #chan');
		expect(ircState.messageActions).toBeNull();
	});
});

describe('MessageActionMenu — sheet', () => {
	it('renders the touch sheet instead of the positioned menu and closes from the scrim', async () => {
		setup([]);
		open(createMessage({ nick: 'alice', text: 'hello', msgid: 'dc-1' }), true);

		expect(document.querySelector('.messageActionSheet')).toBeInTheDocument();
		expect(document.querySelector('.contextMenu')).toBeNull();
		expect(item('reply')).toBeInTheDocument();

		(document.querySelector('.messageActionSheet__scrim') as HTMLElement).click();
		flushSync();
		expect(ircState.messageActions).toBeNull();
	});
});
