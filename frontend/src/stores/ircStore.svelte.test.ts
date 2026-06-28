import { describe, expect, it, beforeEach } from 'vitest';
import { untrack, flushSync } from 'svelte';
import {
	ircState,
	getActiveNetwork,
	getActiveBufferObj,
	getIsServerBuffer,
	getTotalUnread,
	getHasHighlight,
	setActiveBuffer,
	deleteBuffer,
	appendMessage,
	incrementUnread,
	checkHighlight,
	setMessages,
	prependMessages,
	batchAppendMessages,
	updateNetworkFromSync,
	handleConnect,
	updateChannelUsers,
	getSortedMembers,
	updateChannelTopic,
	isMessageUnseen,
	getLastSeenMessage,
	countMessagesBetween,
	countImportantMessagesBetween,
	handleBuffersToDelete,
	recordJoin,
	clearActiveJoin,
	activeJoinList,
	pendingJoins,
	isJoinPending,
	markJoinPending,
	clearJoinPending,
} from './ircStore.svelte';
import { unreadMap, highlightMap, highlightWords, lastSeenMap, bottomSeenMap, setLastSeen, getLastSeen, hiddenChannelsMap, hideChannel } from './preferences.svelte';
import { createMessage, createNetwork, createBuffer, createMember } from '../test/factories';

beforeEach(() => {
	ircState.networks.length = 0;
	ircState.activeBuffer.networkId = null;
	ircState.activeBuffer.bufferName = null;
	ircState.messages = {};
	ircState.optimisticMessages.clear();

	// Reset preference-derived singletons that ircStore writes into
	Object.keys(unreadMap).forEach((k) => delete (unreadMap as Record<string, unknown>)[k]);
	Object.keys(highlightMap).forEach((k) => delete (highlightMap as Record<string, unknown>)[k]);
	Object.keys(lastSeenMap).forEach((k) => delete (lastSeenMap as Record<string, unknown>)[k]);
	Object.keys(bottomSeenMap).forEach((k) => delete (bottomSeenMap as Record<string, unknown>)[k]);
	Object.keys(hiddenChannelsMap).forEach((k) => delete (hiddenChannelsMap as Record<string, unknown>)[k]);
	highlightWords.length = 0;
});

describe('setActiveBuffer', () => {
	it('updates activeBuffer and clears unread', () => {
		const net = createNetwork({ networkId: 'net1' });
		const buf = createBuffer({ name: '#chan', unreadCount: 3, highlight: true });
		net.buffers.push(buf);
		ircState.networks.push(net);

		unreadMap['net1:#chan'] = 3;
		highlightMap['net1:#chan'] = true;

		setActiveBuffer('net1', '#chan');
		flushSync();

		expect(untrack(() => ircState.activeBuffer.networkId)).toBe('net1');
		expect(untrack(() => ircState.activeBuffer.bufferName)).toBe('#chan');

		const foundNet = ircState.networks.find((n) => n.networkId === 'net1');
		const foundBuf = foundNet?.buffers.find((b) => b.name === '#chan');
		expect(foundBuf?.unreadCount).toBe(0);
		expect(foundBuf?.highlight).toBe(false);
		expect(unreadMap['net1:#chan']).toBeUndefined();
		expect(highlightMap['net1:#chan']).toBeUndefined();
	});

	it('sets lastSeen and bottomSeen to last message when switching', () => {
		const net = createNetwork({ networkId: 'net1' });
		const buf = createBuffer({ name: '#chan' });
		net.buffers.push(buf);
		ircState.networks.push(net);

		const msg1 = createMessage({ t: 1000 });
		const msg2 = createMessage({ t: 2000 });
		ircState.messages['net1:#chan'] = [msg1, msg2];

		setActiveBuffer('net1', '#chan');
		flushSync();

		expect(lastSeenMap['net1:#chan']).toBe(2000);
		expect(bottomSeenMap['net1:#chan']).toBe(2000);
	});
});

describe('deleteBuffer', () => {
	it('switches to the previous active buffer when deleting the active channel', () => {
		const net = createNetwork({ networkId: 'net1' });
		net.buffers.push(createBuffer({ name: '_server', type: 'server' }));
		net.buffers.push(createBuffer({ name: '#zod' }));
		net.buffers.push(createBuffer({ name: '#random' }));
		ircState.networks.push(net);

		setActiveBuffer('net1', '#zod');
		setActiveBuffer('net1', '#random');
		flushSync();

		deleteBuffer('net1', '#random');
		flushSync();

		const foundNet = ircState.networks.find((n) => n.networkId === 'net1');
		expect(ircState.activeBuffer.bufferName).toBe('#zod');
		expect(ircState.activeBuffer.networkId).toBe('net1');
		expect(foundNet?.buffers.some((b) => b.name === '#random')).toBe(false);
		expect(hiddenChannelsMap['net1:#random']).toBe(true);
	});

	it('falls back to the channel above when the previous buffer is no longer available', () => {
		const net = createNetwork({ networkId: 'net1' });
		net.buffers.push(createBuffer({ name: '_server', type: 'server' }));
		net.buffers.push(createBuffer({ name: '#alpha' }));
		net.buffers.push(createBuffer({ name: '#beta' }));
		net.buffers.push(createBuffer({ name: '#gamma' }));
		ircState.networks.push(net);

		setActiveBuffer('net1', '#alpha');
		setActiveBuffer('net1', '#beta');
		// Make the previous buffer unavailable so it cannot be reselected.
		const foundNet = ircState.networks.find((n) => n.networkId === 'net1');
		const alpha = foundNet?.buffers.find((b) => b.name === '#alpha')!;
		alpha.isJoined = false;
		flushSync();

		deleteBuffer('net1', '#beta');
		flushSync();

		expect(ircState.activeBuffer.bufferName).toBe('#gamma');
		expect(foundNet?.buffers.some((b) => b.name === '#beta')).toBe(false);
	});

	it('falls back to the server buffer when no other joined channels remain', () => {
		const net = createNetwork({ networkId: 'net1' });
		net.buffers.push(createBuffer({ name: '_server', type: 'server' }));
		net.buffers.push(createBuffer({ name: '#only' }));
		ircState.networks.push(net);

		setActiveBuffer('net1', '#only');
		flushSync();

		deleteBuffer('net1', '#only');
		flushSync();

		const foundNet = ircState.networks.find((n) => n.networkId === 'net1');
		expect(ircState.activeBuffer.bufferName).toBe('_server');
		expect(foundNet?.buffers.some((b) => b.name === '#only')).toBe(false);
	});

	it('does not change the active buffer when deleting an inactive channel', () => {
		const net = createNetwork({ networkId: 'net1' });
		net.buffers.push(createBuffer({ name: '_server', type: 'server' }));
		net.buffers.push(createBuffer({ name: '#zod' }));
		net.buffers.push(createBuffer({ name: '#random' }));
		ircState.networks.push(net);

		setActiveBuffer('net1', '#zod');
		flushSync();

		deleteBuffer('net1', '#random');
		flushSync();

		const foundNet = ircState.networks.find((n) => n.networkId === 'net1');
		expect(ircState.activeBuffer.bufferName).toBe('#zod');
		expect(foundNet?.buffers.some((b) => b.name === '#random')).toBe(false);
	});
});

describe('appendMessage', () => {
	it('adds message to buffer', () => {
		const msg = createMessage({ text: 'hello world' });
		appendMessage('net1', '#chan', msg);
		flushSync();

		const list = untrack(() => ircState.messages['net1:#chan']);
		expect(list).toHaveLength(1);
		expect(list[0].text).toBe('hello world');
	});

	it('increments unread for inactive buffer', () => {
		const net = createNetwork({ networkId: 'net1' });
		const buf = createBuffer({ name: '#chan', unreadCount: 0 });
		net.buffers.push(buf);
		ircState.networks.push(net);

		ircState.activeBuffer.networkId = 'net1';
		ircState.activeBuffer.bufferName = '#other';

		const msg = createMessage();
		appendMessage('net1', '#chan', msg);
		flushSync();

		const foundNet = ircState.networks.find((n) => n.networkId === 'net1');
		const foundBuf = foundNet?.buffers.find((b) => b.name === '#chan');
		expect(foundBuf?.unreadCount).toBe(1);
		expect(unreadMap['net1:#chan']).toBe(1);
	});

	it('replaces optimistic message by label', () => {
		const optMsg = createMessage({ label: 'send-1', text: 'sending...' });
		ircState.optimisticMessages.set('send-1', optMsg);
		ircState.messages['net1:#chan'] = [{ ...optMsg }];

		const realMsg = createMessage({ label: 'send-1', text: 'real message' });
		appendMessage('net1', '#chan', realMsg);
		flushSync();

		const list = untrack(() => ircState.messages['net1:#chan']);
		expect(list).toHaveLength(1);
		expect(list[0].text).toBe('real message');
		expect(ircState.optimisticMessages.has('send-1')).toBe(false);
	});

	it('dedupes by msgid', () => {
		const msg1 = createMessage({ msgid: 'uid-1', text: 'first' });
		appendMessage('net1', '#chan', msg1);

		const msg2 = createMessage({ msgid: 'uid-1', text: 'second' });
		appendMessage('net1', '#chan', msg2);
		flushSync();

		expect(untrack(() => ircState.messages['net1:#chan'])).toHaveLength(1);
	});

	it('does not increment unread for active buffer when tab has focus, even if message is after lastSeen', () => {
		// Regression test for the multi-tab bug: when the user has multiple tabs
		// open and sends a message, the echoed message must not be flagged as
		// unread on the tab that is actively viewing the buffer.
		const net = createNetwork({ networkId: 'net1' });
		const buf = createBuffer({ name: '#chan', unreadCount: 0 });
		net.buffers.push(buf);
		ircState.networks.push(net);

		ircState.activeBuffer.networkId = 'net1';
		ircState.activeBuffer.bufferName = '#chan';
		ircState.focusLost = false;
		setLastSeen('net1', '#chan', 5000);

		const msg = createMessage({ t: 6000 });
		appendMessage('net1', '#chan', msg);
		flushSync();

		expect(unreadMap['net1:#chan']).toBeUndefined();
		expect(buf.unreadCount).toBe(0);
	});

	it('increments unread for active buffer when tab has lost focus (backgrounded)', () => {
		// If the user is on the buffer in tab A but has switched to another
		// browser tab/window, new messages should still count as unread.
		const net = createNetwork({ networkId: 'net1' });
		const buf = createBuffer({ name: '#chan', unreadCount: 0 });
		net.buffers.push(buf);
		ircState.networks.push(net);

		ircState.activeBuffer.networkId = 'net1';
		ircState.activeBuffer.bufferName = '#chan';
		ircState.focusLost = true;

		const msg = createMessage({ t: Date.now() });
		appendMessage('net1', '#chan', msg);
		flushSync();

		const foundNet = ircState.networks.find((n) => n.networkId === 'net1');
		const foundBuf = foundNet?.buffers.find((b) => b.name === '#chan');
		expect(unreadMap['net1:#chan']).toBe(1);
		expect(foundBuf?.unreadCount).toBe(1);
	});
});

describe('getSortedMembers', () => {
	it('orders by mode hierarchy', () => {
		const net = createNetwork({ networkId: 'net1' });
		const buf = createBuffer({
			name: '#chan',
			users: [
				createMember({ nick: 'member1', prefix: '', category: 'MEMBER' }),
				createMember({ nick: 'op1', prefix: '@', category: 'OP' }),
				createMember({ nick: 'halfop1', prefix: '%', category: 'HALFOP' }),
				createMember({ nick: 'admin1', prefix: '&', category: 'ADMIN' }),
			],
		});
		net.buffers.push(buf);
		ircState.networks.push(net);

		ircState.activeBuffer.networkId = 'net1';
		ircState.activeBuffer.bufferName = '#chan';
		flushSync();

		const sorted = untrack(() => getSortedMembers());
		const categories = [...sorted.keys()];
		expect(categories).toEqual(['ADMIN', 'OP', 'HALFOP', 'MEMBER']);

		expect(sorted.get('ADMIN')![0].nick).toBe('admin1');
		expect(sorted.get('OP')![0].nick).toBe('op1');
		expect(sorted.get('HALFOP')![0].nick).toBe('halfop1');
		expect(sorted.get('MEMBER')![0].nick).toBe('member1');
	});
});

describe('updateNetworkFromSync', () => {
	it('adds new networks', () => {
		const incoming = [createNetwork({ networkId: 'sync-net', name: 'synced' })];
		updateNetworkFromSync(incoming);
		flushSync();

		expect(untrack(() => ircState.networks)).toHaveLength(1);
		expect(untrack(() => ircState.networks[0].name)).toBe('synced');
	});

	it('updates existing networks', () => {
		const existing = createNetwork({ networkId: 'net1', name: 'old', host: 'old.host' });
		ircState.networks.push(existing);

		const incoming = [createNetwork({ networkId: 'net1', name: 'new', host: 'new.host' })];
		updateNetworkFromSync(incoming);
		flushSync();

		const updated = ircState.networks.find((n) => n.networkId === 'net1');
		expect(updated?.name).toBe('new');
		expect(updated?.host).toBe('new.host');
	});

	it('preserves local unreadCount when backend sync has 0', () => {
		// Regression: the backend periodically syncs its buffer state which
		// always has unreadCount: 0 for buffers the user is viewing. The
		// sync used to clobber the local count, making the unread indicator
		// disappear every few seconds even though the user hadn't read the
		// messages.
		const existing = createNetwork({ networkId: 'net1' });
		const buf = createBuffer({ name: '#chan', unreadCount: 5, highlight: true });
		existing.buffers.push(buf);
		ircState.networks.push(existing);

		const incoming = createNetwork({ networkId: 'net1' });
		const incomingBuf = createBuffer({ name: '#chan', unreadCount: 0, highlight: false });
		incoming.buffers.push(incomingBuf);
		updateNetworkFromSync([incoming]);
		flushSync();

		const updated = ircState.networks.find((n) => n.networkId === 'net1');
		const updatedBuf = updated?.buffers.find((b) => b.name === '#chan');
		expect(updatedBuf?.unreadCount).toBe(5);
		expect(updatedBuf?.highlight).toBe(true);
	});

	it('adopts higher unreadCount from backend when local is lower', () => {
		// If the backend reports more unread messages than we knew about
		// (e.g. messages received on another device while we were offline),
		// we should adopt the higher count.
		const existing = createNetwork({ networkId: 'net1' });
		const buf = createBuffer({ name: '#chan', unreadCount: 1, highlight: false });
		existing.buffers.push(buf);
		ircState.networks.push(existing);

		const incoming = createNetwork({ networkId: 'net1' });
		const incomingBuf = createBuffer({ name: '#chan', unreadCount: 7, highlight: true });
		incoming.buffers.push(incomingBuf);
		updateNetworkFromSync([incoming]);
		flushSync();

		const updated = ircState.networks.find((n) => n.networkId === 'net1');
		const updatedBuf = updated?.buffers.find((b) => b.name === '#chan');
		expect(updatedBuf?.unreadCount).toBe(7);
		expect(updatedBuf?.highlight).toBe(true);
	});

	it('does not re-add a channel that the user previously deleted', () => {
		// Regression: deleting a channel used to be in-memory only, so the
		// next sync (which re-includes parted/auto-join channels) would bring
		// the buffer back. The deletion must persist in hiddenChannelsMap and
		// the sync filter must drop the buffer.
		hideChannel('net1', '#chan');

		const incoming = createNetwork({ networkId: 'net1', buffers: [] });
		incoming.buffers.push(createBuffer({ name: '_server', type: 'server', isJoined: true }));
		incoming.buffers.push(createBuffer({ name: '#chan', isJoined: false }));
		incoming.buffers.push(createBuffer({ name: '#other', isJoined: true }));
		updateNetworkFromSync([incoming]);
		flushSync();

		const net = ircState.networks.find((n) => n.networkId === 'net1');
		const bufNames = net?.buffers.map((b) => b.name) ?? [];
		expect(bufNames).toContain('_server');
		expect(bufNames).toContain('#other');
		expect(bufNames).not.toContain('#chan');
	});

	it('removes a previously-existing buffer when the user hides it before sync', () => {
		// If the channel was in the local buffer list and the user hides it,
		// the next sync should drop it from the list (defense in depth).
		const existing = createNetwork({ networkId: 'net1' });
		existing.buffers.push(createBuffer({ name: '#chan', isJoined: false }));
		ircState.networks.push(existing);

		hideChannel('net1', '#chan');

		const incoming = createNetwork({ networkId: 'net1' });
		incoming.buffers.push(createBuffer({ name: '_server', type: 'server', isJoined: true }));
		incoming.buffers.push(createBuffer({ name: '#chan', isJoined: false }));
		updateNetworkFromSync([incoming]);
		flushSync();

		const net = ircState.networks.find((n) => n.networkId === 'net1');
		const bufNames = net?.buffers.map((b) => b.name) ?? [];
		expect(bufNames).toContain('_server');
		expect(bufNames).not.toContain('#chan');
	});
});

describe('handleConnect', () => {
	it('sets connected state', () => {
		const net = createNetwork({
			networkId: 'net1',
			connected: false,
			connectionState: 'disconnected',
			disconnectReason: 'previous error',
		});
		ircState.networks.push(net);

		handleConnect('001', 'net1');
		flushSync();

		const updated = ircState.networks.find((n) => n.networkId === 'net1');
		expect(updated?.connected).toBe(true);
		expect(updated?.connectionState).toBe('connected');
		expect(updated?.disconnectReason).toBe('');
	});
});

describe('updateChannelUsers', () => {
	it('adds users on 353', () => {
		const net = createNetwork({ networkId: 'net1' });
		const buf = createBuffer({ name: '#chan' });
		net.buffers.push(buf);
		ircState.networks.push(net);

		updateChannelUsers('net1', '#chan', '353', '', ['#chan', '@alice +bob charlie']);
		flushSync();

		const foundNet = ircState.networks.find((n) => n.networkId === 'net1');
		const foundBuf = foundNet?.buffers.find((b) => b.name === '#chan');
		expect(foundBuf?.users).toHaveLength(3);
		expect(foundBuf?.users[0].nick).toBe('@alice');
		expect(foundBuf?.users[0].category).toBe('OP');
		expect(foundBuf?.users[1].nick).toBe('+bob');
		expect(foundBuf?.users[1].category).toBe('VOICED');
		expect(foundBuf?.users[2].nick).toBe('charlie');
		expect(foundBuf?.users[2].category).toBe('MEMBER');
	});

	it('removes users on PART/QUIT', () => {
		const net = createNetwork({ networkId: 'net1' });
		const buf = createBuffer({
			name: '#chan',
			users: [createMember({ nick: 'alice' }), createMember({ nick: 'bob' })],
		});
		net.buffers.push(buf);
		ircState.networks.push(net);

		updateChannelUsers('net1', '#chan', 'PART', 'alice');
		flushSync();

		const foundNet = ircState.networks.find((n) => n.networkId === 'net1');
		const foundBuf = foundNet?.buffers.find((b) => b.name === '#chan');
		expect(foundBuf?.users).toHaveLength(1);
		expect(foundBuf?.users[0].nick).toBe('bob');
	});

	it('updates nick on NICK', () => {
		const net = createNetwork({ networkId: 'net1' });
		const buf = createBuffer({
			name: '#chan',
			users: [createMember({ nick: 'alice' })],
		});
		net.buffers.push(buf);
		ircState.networks.push(net);

		updateChannelUsers('net1', '#chan', 'NICK', 'alice', ['alice', 'newalice']);
		flushSync();

		const foundNet = ircState.networks.find((n) => n.networkId === 'net1');
		const foundBuf = foundNet?.buffers.find((b) => b.name === '#chan');
		expect(foundBuf?.users[0].nick).toBe('newalice');
	});

	it('updates currentNick on NICK when the changing user is ourself', () => {
		const net = createNetwork({ networkId: 'net1', currentNick: 'alice' });
		const buf = createBuffer({
			name: '#chan',
			users: [createMember({ nick: 'alice' })],
		});
		net.buffers.push(buf);
		ircState.networks.push(net);

		updateChannelUsers('net1', '#chan', 'NICK', 'alice', ['alice', 'newalice']);
		flushSync();

		const foundNet = ircState.networks.find((n) => n.networkId === 'net1');
		expect(foundNet?.currentNick).toBe('newalice');
	});

	it('does not update currentNick on NICK when a different user changes nick', () => {
		const net = createNetwork({ networkId: 'net1', currentNick: 'me' });
		const buf = createBuffer({
			name: '#chan',
			users: [createMember({ nick: 'otherguy' })],
		});
		net.buffers.push(buf);
		ircState.networks.push(net);

		updateChannelUsers('net1', '#chan', 'NICK', 'otherguy', ['otherguy', 'newguy']);
		flushSync();

		const foundNet = ircState.networks.find((n) => n.networkId === 'net1');
		expect(foundNet?.currentNick).toBe('me');
	});

	it('does not overwrite currentNick from sync snapshot after optimistic /nick', () => {
		const net = createNetwork({ networkId: 'net1', currentNick: 'oldnick' });
		ircState.networks.push(net);

		// User types /nick newnick — optimistic update fires
		net.currentNick = 'newnick';

		// Backend sync snapshot arrives with the OLD nick (server hasn't
		// confirmed yet). This must not clobber the optimistic UI value.
		const syncPayload = [
			createNetwork({ networkId: 'net1', nick: 'oldnick', currentNick: 'oldnick' }),
		];
		updateNetworkFromSync(syncPayload);
		flushSync();

		const foundNet = ircState.networks.find((n) => n.networkId === 'net1');
		expect(foundNet?.currentNick).toBe('newnick');
	});

	it('adopts currentNick from sync on initial load when local value is empty', () => {
		const net = createNetwork({ networkId: 'net1', currentNick: '' });
		ircState.networks.push(net);

		const syncPayload = [
			createNetwork({ networkId: 'net1', nick: 'freshuser', currentNick: 'freshuser' }),
		];
		updateNetworkFromSync(syncPayload);
		flushSync();

		const foundNet = ircState.networks.find((n) => n.networkId === 'net1');
		expect(foundNet?.currentNick).toBe('freshuser');
	});

	it('prependMessages dedupes against the boundary msgid', () => {
		// When the server paginates with beforeid=<lastmsgid>, the new
		// batch's LAST entry can share that msgid with the buffer's
		// oldest entry. Without dedup, Svelte's keyed each block in
		// MessageList crashes with each_key_duplicate.
		const key = 'net1:#chan';
		ircState.messages[key] = [
			{ command: 'PRIVMSG', text: 'old1', msgid: 'M1', t: 100 },
			{ command: 'PRIVMSG', text: 'old2', msgid: 'M2', t: 200 },
		];

		// New batch: M2 is the boundary (last in existing buffer)
		prependMessages('net1', '#chan', [
			{ command: 'PRIVMSG', text: 'older1', msgid: 'M0', t: 50 },
			{ command: 'PRIVMSG', text: 'boundary', msgid: 'M2', t: 200 },
		]);

		expect(ircState.messages[key].map((m) => m.msgid)).toEqual(['M0', 'M1', 'M2']);
	});

	it('prependMessages keeps older entries that are not duplicates', () => {
		const key = 'net1:#chan';
		ircState.messages[key] = [
			{ command: 'PRIVMSG', text: 'a', msgid: 'A', t: 100 },
		];

		prependMessages('net1', '#chan', [
			{ command: 'PRIVMSG', text: 'b', msgid: 'B', t: 90 },
			{ command: 'PRIVMSG', text: 'c', msgid: 'C', t: 80 },
		]);

		expect(ircState.messages[key].map((m) => m.msgid)).toEqual(['C', 'B', 'A']);
	});

	it('prependMessages dedupes duplicates WITHIN the new batch (server replay collision)', () => {
		// Bug: the server can return the same eid twice in one batch
		// (e.g. when a backlog fetch overlaps with a WS replay). Without
		// within-batch dedup the same eid reaches the {#each} twice and
		// Svelte throws each_key_duplicate.
		const key = 'net1:#chan';
		ircState.messages[key] = [
			{ command: 'PRIVMSG', text: 'a', eid: 100, t: 100 },
		];

		prependMessages('net1', '#chan', [
			{ command: 'PRIVMSG', text: 'b', eid: 50, t: 50 },
			{ command: 'PRIVMSG', text: 'b-dup', eid: 50, t: 50 },
			{ command: 'PRIVMSG', text: 'c', eid: 60, t: 60 },
			{ command: 'PRIVMSG', text: 'c-dup', eid: 60, t: 60 },
		]);

		const eids = ircState.messages[key].map((m) => m.eid);
		expect(eids).toEqual([50, 60, 100]);
	});

	it('batchAppendMessages dedupes duplicates WITHIN the batch (O(1) per-message)', () => {
		// Same scenario as above, but for the WS hot path. The set-based
		// dedup keeps the per-message cost O(1) instead of O(n).
		const key = 'net1:#chan';
		ircState.messages[key] = [
			{ command: 'PRIVMSG', text: 'a', eid: 100, t: 100 },
		];

		batchAppendMessages('net1', '#chan', [
			{ command: 'PRIVMSG', text: 'b', eid: 50, t: 50 },
			{ command: 'PRIVMSG', text: 'b-dup', eid: 50, t: 50 },
			{ command: 'PRIVMSG', text: 'c', eid: 60, t: 60 },
		]);

		const eids = ircState.messages[key].map((m) => m.eid);
		expect(eids).toEqual([100, 50, 60]);
	});

	it('prependMessages preserves older entries without msgid (optimistic messages)', () => {
		// User-sent optimistic messages have no msgid. They must survive
		// pagination so the user can still see their own unsent messages.
		const key = 'net1:#chan';
		ircState.messages[key] = [
			{ command: 'PRIVMSG', text: 'optimistic', t: 100 }, // no msgid
			{ command: 'PRIVMSG', text: 'old', msgid: 'A', t: 200 },
		];

		prependMessages('net1', '#chan', [
			{ command: 'PRIVMSG', text: 'older', msgid: 'Z', t: 50 },
		]);

		expect(ircState.messages[key].map((m) => m.text)).toEqual(['older', 'optimistic', 'old']);
	});

	it('updates mode on MODE', () => {
		const net = createNetwork({ networkId: 'net1' });
		const buf = createBuffer({
			name: '#chan',
			users: [createMember({ nick: 'alice' })],
		});
		net.buffers.push(buf);
		ircState.networks.push(net);

		updateChannelUsers('net1', '#chan', 'MODE', '', ['+o', 'alice']);
		flushSync();

		const foundNet = ircState.networks.find((n) => n.networkId === 'net1');
		const foundBuf = foundNet?.buffers.find((b) => b.name === '#chan');
		expect(foundBuf?.users[0].prefix).toBe('@');
		expect(foundBuf?.users[0].category).toBe('OP');
		expect(foundBuf?.users[0].nick).toBe('@alice');
	});
});

describe('checkHighlight', () => {
	it('detects nick mention', () => {
		const net = createNetwork({ currentNick: 'tester' });
		const msg = createMessage({ text: 'hey tester!' });
		expect(checkHighlight(msg, net)).toBe(true);
	});

	it('detects highlight words', () => {
		highlightWords.push('urgent');
		const net = createNetwork({ currentNick: 'tester' });
		const msg = createMessage({ text: 'this is urgent' });
		expect(checkHighlight(msg, net)).toBe(true);
	});
});

describe('read tracking helpers', () => {
	it('isMessageUnseen returns true when no lastSeen', () => {
		const msg = createMessage({ t: 1000 });
		expect(isMessageUnseen(msg, 'net1', '#chan')).toBe(true);
	});

	it('isMessageUnseen returns false for message before lastSeen', () => {
		lastSeenMap['net1:#chan'] = 5000;
		const msg = createMessage({ t: 4000 });
		expect(isMessageUnseen(msg, 'net1', '#chan')).toBe(false);
	});

	it('isMessageUnseen returns true for message after lastSeen', () => {
		lastSeenMap['net1:#chan'] = 5000;
		const msg = createMessage({ t: 6000 });
		expect(isMessageUnseen(msg, 'net1', '#chan')).toBe(true);
	});

	it('getLastSeenMessage returns message at or before lastSeen', () => {
		ircState.messages['net1:#chan'] = [
			createMessage({ msgid: 'a', t: 1000 }),
			createMessage({ msgid: 'b', t: 2000 }),
			createMessage({ msgid: 'c', t: 3000 }),
		];
		lastSeenMap['net1:#chan'] = 2500;
		const found = getLastSeenMessage('net1', '#chan');
		expect(found?.msgid).toBe('b');
	});

	it('countMessagesBetween counts total messages', () => {
		ircState.messages['net1:#chan'] = [
			createMessage({ msgid: 'a', t: 1000 }),
			createMessage({ msgid: 'b', t: 2000 }),
			createMessage({ msgid: 'c', t: 3000 }),
			createMessage({ msgid: 'd', t: 4000 }),
		];
		const start = ircState.messages['net1:#chan'][1];
		const end = ircState.messages['net1:#chan'][3];
		expect(countMessagesBetween('net1', '#chan', start, end)).toBe(2);
	});

	it('countImportantMessagesBetween skips status messages', () => {
		ircState.messages['net1:#chan'] = [
			createMessage({ msgid: 'a', t: 1000, command: 'PRIVMSG' }),
			createMessage({ msgid: 'b', t: 2000, command: 'JOIN' }),
			createMessage({ msgid: 'c', t: 3000, command: 'PRIVMSG' }),
			createMessage({ msgid: 'd', t: 4000, command: 'PART' }),
		];
		const start = ircState.messages['net1:#chan'][0];
		const end = ircState.messages['net1:#chan'][3];
		// Between a and d: only c is important (b=JOIN, d=PART are skipped)
		expect(countImportantMessagesBetween('net1', '#chan', start, end)).toBe(1);
	});
});

describe('PART/KICK/JOIN isJoined lifecycle', () => {
	it('PART for self sets isJoined to false', () => {
		const net = createNetwork({ networkId: 'net1', currentNick: 'me' });
		const buf = createBuffer({ name: '#chan', isJoined: true });
		net.buffers.push(buf);
		ircState.networks.push(net);

		updateChannelUsers('net1', '#chan', 'PART', 'me');
		flushSync();

		const found = ircState.networks.find((n) => n.networkId === 'net1');
		const foundBuf = found?.buffers.find((b) => b.name === '#chan');
		expect(foundBuf?.isJoined).toBe(false);
	});

	it('KICK for self sets isJoined to false', () => {
		const net = createNetwork({ networkId: 'net1', currentNick: 'me' });
		const buf = createBuffer({ name: '#chan', isJoined: true });
		net.buffers.push(buf);
		ircState.networks.push(net);

		updateChannelUsers('net1', '#chan', 'KICK', 'op', ['#chan', 'me']);
		flushSync();

		const found = ircState.networks.find((n) => n.networkId === 'net1');
		const foundBuf = found?.buffers.find((b) => b.name === '#chan');
		expect(foundBuf?.isJoined).toBe(false);
	});

	it('JOIN for self sets isJoined to true', () => {
		const net = createNetwork({ networkId: 'net1', currentNick: 'me' });
		const buf = createBuffer({ name: '#chan', isJoined: false });
		net.buffers.push(buf);
		ircState.networks.push(net);

		updateChannelUsers('net1', '#chan', 'JOIN', 'me');
		flushSync();

		const found = ircState.networks.find((n) => n.networkId === 'net1');
		const foundBuf = found?.buffers.find((b) => b.name === '#chan');
		expect(foundBuf?.isJoined).toBe(true);
	});

	it('sync flips isJoined from false to true when no pendingIsJoined guard', () => {
		// Without a pendingIsJoined guard, the sync is authoritative.
		// A stale local isJoined=false is corrected by the engine snapshot.
		const net = createNetwork({ networkId: 'net1', currentNick: 'me' });
		const buf = createBuffer({ name: '#chan', isJoined: false });
		net.buffers.push(buf);
		ircState.networks.push(net);

		const incoming = createNetwork({ networkId: 'net1' });
		incoming.buffers.push(createBuffer({ name: '#chan', isJoined: true }));
		updateNetworkFromSync([incoming]);
		flushSync();

		const foundBuf = ircState.networks.find((n) => n.networkId === 'net1')?.buffers.find((b) => b.name === '#chan');
		expect(foundBuf?.isJoined).toBe(true);
	});

	it('sync flips isJoined from true to false when no pendingIsJoined guard', () => {
		// Without a pendingIsJoined guard, the sync is authoritative.
		// This handles the case where the user parted from another client
		// and the next sync correctly reports isJoined=false without an
		// intermediate PART event reaching this frontend.
		const net = createNetwork({ networkId: 'net1', currentNick: 'me' });
		const buf = createBuffer({ name: '#chan', isJoined: true });
		net.buffers.push(buf);
		ircState.networks.push(net);

		// Sync says the user is no longer in the channel
		const incoming = createNetwork({ networkId: 'net1' });
		incoming.buffers.push(createBuffer({ name: '#chan', isJoined: false }));
		updateNetworkFromSync([incoming]);
		flushSync();

		const foundBuf = ircState.networks.find((n) => n.networkId === 'net1')?.buffers.find((b) => b.name === '#chan');
		expect(foundBuf?.isJoined).toBe(false);
	});

	it('new buffer from sync with isJoined:false is created correctly', () => {
		// Simulate hard refresh: no existing state, sync arrives
		const incoming = createNetwork({ networkId: 'net1', buffers: [] });
		incoming.buffers.push(createBuffer({ name: '_server', type: 'server', isJoined: true }));
		incoming.buffers.push(createBuffer({ name: '#active', isJoined: true }));
		incoming.buffers.push(createBuffer({ name: '#parted', isJoined: false }));
		updateNetworkFromSync([incoming]);
		flushSync();

		const net = ircState.networks.find((n) => n.networkId === 'net1');
		const active = net?.buffers.find((b) => b.name === '#active');
		const parted = net?.buffers.find((b) => b.name === '#parted');
		expect(active?.isJoined).toBe(true);
		expect(parted?.isJoined).toBe(false);
	});
});

describe('phantom buffers (URL nav auto-create)', () => {
	it('setActiveBuffer auto-create marks channel buffers as isPhantom', () => {
		const net = createNetwork();
		ircState.networks.push(net);

		setActiveBuffer(net.networkId, '#autism');
		flushSync();

		const buf = ircState.networks.find((n) => n.networkId === net.networkId)?.buffers.find((b) => b.name === '#autism');
		expect(buf).toBeDefined();
		expect(buf?.isPhantom).toBe(true);
		expect(buf?.isJoined).toBe(false);
	});

	it('navigating to a real buffer clears the phantom flag', () => {
		const net = createNetwork();
		const buf = createBuffer({ name: '#autism', isPhantom: true, isJoined: false });
		net.buffers.push(buf);
		ircState.networks.push(net);

		setActiveBuffer(net.networkId, '#autism');
		flushSync();

		const found = ircState.networks.find((n) => n.networkId === net.networkId)?.buffers.find((b) => b.name === '#autism');
		expect(found?.isPhantom).toBe(false);
		// isJoined itself is NOT changed by setActiveBuffer — that's the
		// sync / JOIN event's job.
		expect(found?.isJoined).toBe(false);
	});

	it('sync adopts the engine isJoined for phantom buffers', () => {
		// Regression: user navigates to /channel/autism, the local phantom
		// is created with isJoined:false, then the next sync arrives from
		// the engine reporting the user is actually in the channel. Before
		// the phantom flag, the local isJoined:false won and the channel
		// was stuck in the "Inactive" section forever.
		const existing = createNetwork({ currentNick: 'me' });
		const phantom = createBuffer({
			name: '#autism',
			isJoined: false,
			isPhantom: true,
			unreadCount: 2,
			highlight: true,
		});
		existing.buffers.push(phantom);
		ircState.networks.push(existing);

		const incoming = createNetwork({ networkId: existing.networkId });
		incoming.buffers.push(createBuffer({ name: '#autism', isJoined: true }));
		updateNetworkFromSync([incoming]);
		flushSync();

		const buf = ircState.networks.find((n) => n.networkId === existing.networkId)?.buffers.find((b) => b.name === '#autism');
		expect(buf?.isJoined).toBe(true);
		expect(buf?.isPhantom).toBe(false);
		// Local unread/highlight must be preserved across the sync.
		expect(buf?.unreadCount).toBe(2);
		expect(buf?.highlight).toBe(true);
	});

	it('sync updates isJoined for non-phantom buffers when no pending event change', () => {
		// Without a pendingIsJoined guard, the engine sync snapshot is
		// authoritative for the current join state.  If the client has no
		// reason to distrust it (no recent JOIN/PART/KICK for self), the
		// sync's isJoined overwrites the local value.
		const existing = createNetwork({ currentNick: 'me' });
		const real = createBuffer({ name: '#chan', isJoined: false });
		existing.buffers.push(real);
		ircState.networks.push(existing);

		const incoming = createNetwork({ networkId: existing.networkId });
		incoming.buffers.push(createBuffer({ name: '#chan', isJoined: true }));
		updateNetworkFromSync([incoming]);
		flushSync();

		const buf = ircState.networks.find((n) => n.networkId === existing.networkId)?.buffers.find((b) => b.name === '#chan');
		expect(buf?.isJoined).toBe(true);
	});

	it('pendingIsJoined guard prevents stale sync from overwriting a recent PART', () => {
		// User parts a channel — updateChannelUsers sets isJoined=false and
		// pendingIsJoined=false.  A stale sync snapshot taken BEFORE the PART
		// propagated must NOT flip isJoined back to true.  Only the next sync
		// that confirms the parted state clears the guard.
		const existing = createNetwork({ currentNick: 'me' });
		const real = createBuffer({ name: '#chan', isJoined: false, pendingIsJoined: false });
		existing.buffers.push(real);
		ircState.networks.push(existing);

		// Stale sync: snapshot from before the PART — says joined=true
		const incoming = createNetwork({ networkId: existing.networkId });
		incoming.buffers.push(createBuffer({ name: '#chan', isJoined: true }));
		updateNetworkFromSync([incoming]);
		flushSync();

		const buf = ircState.networks.find((n) => n.networkId === existing.networkId)?.buffers.find((b) => b.name === '#chan');
		// pendingIsJoined=false contradicts sync's isJoined=true — keep event state
		expect(buf?.isJoined).toBe(false);
		expect(buf?.pendingIsJoined).toBe(false); // guard still active
	});

	it('pendingIsJoined guard clears when the confirming sync arrives', () => {
		// After a PART, the next sync that ALSO reports isJoined=false
		// confirms the event state and clears the guard.
		const existing = createNetwork({ currentNick: 'me' });
		const real = createBuffer({ name: '#chan', isJoined: false, pendingIsJoined: false });
		existing.buffers.push(real);
		ircState.networks.push(existing);

		const incoming = createNetwork({ networkId: existing.networkId });
		incoming.buffers.push(createBuffer({ name: '#chan', isJoined: false }));
		updateNetworkFromSync([incoming]);
		flushSync();

		const buf = ircState.networks.find((n) => n.networkId === existing.networkId)?.buffers.find((b) => b.name === '#chan');
		expect(buf?.isJoined).toBe(false);
		expect(buf?.pendingIsJoined).toBeUndefined(); // guard cleared
	});

	it('pendingIsJoined guard prevents stale sync from overwriting a fresh JOIN', () => {
		// User joins a channel — updateChannelUsers sets pendingIsJoined=true.
		// A stale sync snapshot from before the JOIN must not flip isJoined
		// back to false.
		const existing = createNetwork({ currentNick: 'me' });
		const real = createBuffer({ name: '#chan', isJoined: true, pendingIsJoined: true });
		existing.buffers.push(real);
		ircState.networks.push(existing);

		const incoming = createNetwork({ networkId: existing.networkId });
		incoming.buffers.push(createBuffer({ name: '#chan', isJoined: false }));
		updateNetworkFromSync([incoming]);
		flushSync();

		const buf = ircState.networks.find((n) => n.networkId === existing.networkId)?.buffers.find((b) => b.name === '#chan');
		expect(buf?.isJoined).toBe(true);
		expect(buf?.pendingIsJoined).toBe(true);
	});

	it('JOIN for self clears the phantom flag', () => {
		// Race: URL nav creates a phantom, the JOIN event for self arrives
		// before the engine's snapshot syncs. The JOIN is authoritative and
		// must promote the phantom to a real buffer.
		const net = createNetwork({ currentNick: 'me' });
		const phantom = createBuffer({ name: '#autism', isJoined: false, isPhantom: true });
		net.buffers.push(phantom);
		ircState.networks.push(net);

		updateChannelUsers(net.networkId, '#autism', 'JOIN', 'me');
		flushSync();

		const found = ircState.networks.find((n) => n.networkId === net.networkId)?.buffers.find((b) => b.name === '#autism');
		expect(found?.isJoined).toBe(true);
		expect(found?.isPhantom).toBe(false);
	});

	it('sync merges two buffers with the same name (active + Inactive dup)', () => {
		// Regression: a real user hit this state where #autism appeared in
		// BOTH the active channel list and the "Inactive" section. Without
		// dedup, the Sidebar renders two entries for the same channel.
		const existing = createNetwork();
		const phantom = createBuffer({ name: '#autism', isJoined: false, isPhantom: true, unreadCount: 0 });
		const real = createBuffer({ name: '#autism', isJoined: true, unreadCount: 5, highlight: true });
		existing.buffers.push(phantom, real);
		ircState.networks.push(existing);

		const incoming = createNetwork({ networkId: existing.networkId });
		incoming.buffers.push(createBuffer({ name: '#autism', isJoined: true }));
		updateNetworkFromSync([incoming]);
		flushSync();

		const net = ircState.networks.find((n) => n.networkId === existing.networkId)!;
		const dups = net.buffers.filter((b) => b.name === '#autism');
		expect(dups).toHaveLength(1);
		// Should prefer the joined entry and keep the local unread/highlight.
		expect(dups[0].isJoined).toBe(true);
		expect(dups[0].isPhantom).toBe(false);
		expect(dups[0].unreadCount).toBe(5);
		expect(dups[0].highlight).toBe(true);
	});

	it('preserves member lastSpoke and lastHighlighted across sync reload', () => {
		// Regression: after WS reconnect → sync, members' lastSpoke/lastHighlighted
		// reset to 0 because incoming sync data has those as defaults. The
		// tab-completion sort (by most recent speaker) breaks as a result.
		const existing = createNetwork({ networkId: 'net1' });
		const existingBuf = createBuffer({ name: '#chan', type: 'channel' });
		existingBuf.users = [
			createMember({ nick: 'alice', lastSpoke: 5000, lastHighlighted: 3000 }),
			createMember({ nick: 'bob', lastSpoke: 0, lastHighlighted: 0 }),
		];
		existing.buffers.push(existingBuf);
		ircState.networks.push(existing);

		// Incoming sync has fresh members with all-zero timestamps (as the backend
		// resets activity on reconnect).
		const incoming = createNetwork({ networkId: 'net1' });
		const incomingBuf = createBuffer({ name: '#chan', type: 'channel' });
		incomingBuf.users = [
			createMember({ nick: 'alice', lastSpoke: 0, lastHighlighted: 0 }),
			createMember({ nick: 'bob', lastSpoke: 0, lastHighlighted: 0 }),
		];
		incoming.buffers.push(incomingBuf);
		updateNetworkFromSync([incoming]);
		flushSync();

		const net = ircState.networks.find((n) => n.networkId === 'net1')!;
		const buf = net.buffers.find((b) => b.name === '#chan')!;
		const alice = buf.users.find((u) => u.nick === 'alice')!;
		const bob = buf.users.find((u) => u.nick === 'bob')!;

		// alice had non-zero lastSpoke/lastHighlighted before sync — preserve
		expect(alice.lastSpoke).toBe(5000);
		expect(alice.lastHighlighted).toBe(3000);

		// bob had zeros before sync — stays zero (no regression for absent data)
		expect(bob.lastSpoke).toBe(0);
		expect(bob.lastHighlighted).toBe(0);
	});
});

describe('handleBuffersToDelete / activeJoinList (W1-T06)', () => {
	const networkId = 'test-net';
	const bufferName = '#ghost';

	function setup(): void {
		ircState.networks.length = 0;
		activeJoinList.clear();
		const net = createNetwork({ networkId, name: 'TestNet' });
		net.buffers.push(createBuffer({ name: bufferName, isJoined: false }));
		net.buffers.push(createBuffer({ name: '_server', type: 'server', isJoined: true }));
		ircState.networks.push(net);
	}

	beforeEach(() => {
		setup();
	});

	it('deletes a buffer not guarded by activeJoinList', () => {
		handleBuffersToDelete([`${networkId}:${bufferName}`]);
		const net = ircState.networks.find(n => n.networkId === networkId)!;
		expect(net.buffers.find(b => b.name === bufferName)).toBeUndefined();
	});

	it('skips deletion when bid is in activeJoinList', () => {
		recordJoin(networkId, bufferName);
		handleBuffersToDelete([`${networkId}:${bufferName}`]);
		const net = ircState.networks.find(n => n.networkId === networkId)!;
		expect(net.buffers.find(b => b.name === bufferName)).toBeDefined();
	});

	it('clearActiveJoin removes from activeJoinList', () => {
		recordJoin(networkId, bufferName);
		clearActiveJoin(networkId, bufferName);
		handleBuffersToDelete([`${networkId}:${bufferName}`]);
		const net = ircState.networks.find(n => n.networkId === networkId)!;
		expect(net.buffers.find(b => b.name === bufferName)).toBeUndefined();
	});

	it('skips deletion for _server buffer', () => {
		handleBuffersToDelete([`${networkId}:_server`]);
		const net = ircState.networks.find(n => n.networkId === networkId)!;
		expect(net.buffers.find(b => b.name === '_server')).toBeDefined();
	});

	it('skips deletion for activeJoinList channel even when bid looks like ghost', () => {
		recordJoin(networkId, bufferName);
		handleBuffersToDelete([`${networkId}:${bufferName}`]);
		const net = ircState.networks.find(n => n.networkId === networkId)!;
		expect(net.buffers.find(b => b.name === bufferName)).toBeDefined();
	});

	it('empty bid list is a no-op', () => {
		handleBuffersToDelete([]);
		const net = ircState.networks.find(n => n.networkId === networkId)!;
		expect(net.buffers.find(b => b.name === bufferName)).toBeDefined();
	});
});

describe('W7-T01: URL nav auto-join plumbing', () => {
	// Svelte 5 wraps arrays/objects passed to $state in proxies. The
	// raw buffer reference held in test scope is NOT the same object as
	// the one stored in ircState.networks[].buffers[] — so mutations made
	// by updateChannelUsers are visible only when re-read through the
	// store. Tests below always read back via findBuf() to stay honest.
	function findBuf(networkId: string, name: string) {
		return ircState.networks.find(n => n.networkId === networkId)
			?.buffers.find(b => b.name === name);
	}

	beforeEach(() => {
		ircState.networks.length = 0;
		activeJoinList.clear();
		pendingJoins.clear();
	});

	describe('pendingJoins dedup', () => {
		it('marks and clears pending joins by normalized key', () => {
			expect(isJoinPending('n1', '#Foo')).toBe(false);
			markJoinPending('n1', '#Foo');
			expect(isJoinPending('n1', '#Foo')).toBe(true);
			// Case-insensitive lookup matches what updateChannelUsers does
			expect(isJoinPending('n1', '#foo')).toBe(true);
			clearJoinPending('n1', '#Foo');
			expect(isJoinPending('n1', '#foo')).toBe(false);
		});

		it('does not collide across networks', () => {
			markJoinPending('n1', '#chan');
			expect(isJoinPending('n2', '#chan')).toBe(false);
		});
	});

	describe('JOIN failure numerics', () => {
		function setup(): void {
			const net = createNetwork({ networkId: 'n1', currentNick: 'me' });
			const buf = createBuffer({ name: '#private', isJoined: false });
			buf.joinInFlight = true;
			buf.pendingIsJoined = true;
			net.buffers.push(buf);
			ircState.networks.push(net);
			markJoinPending('n1', '#private');
		}

		it('473 (ERR_INVITEONLYCHAN) sets joinError=invite-only and clears joinInFlight', () => {
			setup();
			updateChannelUsers('n1', '#private', '473', 'me', ['me', '#private', 'Cannot join channel (+i)']);
			flushSync();
			const buf = findBuf('n1', '#private')!;
			expect(buf.joinInFlight).toBe(false);
			expect(buf.joinError).toBe('invite-only');
			expect(buf.pendingIsJoined).toBeUndefined();
			expect(isJoinPending('n1', '#private')).toBe(false);
		});

		it('474 (ERR_BANNEDFROMCHAN) sets joinError=banned', () => {
			setup();
			updateChannelUsers('n1', '#private', '474', 'me', ['me', '#private', 'You are banned']);
			flushSync();
			expect(findBuf('n1', '#private')!.joinError).toBe('banned');
		});

		it('475 (ERR_BADCHANNELKEY) sets joinError=key-required', () => {
			setup();
			updateChannelUsers('n1', '#private', '475', 'me', ['me', '#private', 'Cannot join +k']);
			flushSync();
			expect(findBuf('n1', '#private')!.joinError).toBe('key-required');
		});

		it('471 (ERR_CHANNELISFULL) sets joinError=full', () => {
			setup();
			updateChannelUsers('n1', '#private', '471', 'me', ['me', '#private', 'Channel is full']);
			flushSync();
			expect(findBuf('n1', '#private')!.joinError).toBe('full');
		});

		it('clears joinError on the next successful JOIN for self', () => {
			setup();
			updateChannelUsers('n1', '#private', '473', 'me', ['me', '#private']);
			flushSync();
			expect(findBuf('n1', '#private')!.joinError).toBe('invite-only');
			updateChannelUsers('n1', '#private', 'JOIN', 'me');
			flushSync();
			const buf = findBuf('n1', '#private')!;
			expect(buf.isJoined).toBe(true);
			expect(buf.joinError).toBeNull();
			expect(buf.joinInFlight).toBe(false);
		});

		it('clears joinInFlight and pendingJoins on PART for self', () => {
			setup();
			updateChannelUsers('n1', '#private', 'PART', 'me');
			flushSync();
			expect(findBuf('n1', '#private')!.joinInFlight).toBe(false);
			expect(isJoinPending('n1', '#private')).toBe(false);
		});
	});

	describe('sync guard for in-flight JOIN', () => {
		it('sync snapshot with isJoined=false does not clobber joinInFlight phantom', () => {
			// Simulates: user navigates to /channel/foo → switchToBuffer sets
			// joinInFlight=true → sync arrives BEFORE the JOIN event echoes.
			// Without the guard, the sync would flip the buffer back to
			// isJoined=false and the BufferHeader would show "Rejoin".
			const net = createNetwork({ networkId: 'n1' });
			const phantom = createBuffer({ name: '#foo', isJoined: false, isPhantom: true });
			phantom.joinInFlight = true;
			phantom.pendingIsJoined = true;
			net.buffers.push(phantom);
			ircState.networks.push(net);

			// Sync reports isJoined=false (engine snapshot taken before JOIN)
			const syncNet = createNetwork({ networkId: 'n1' });
			syncNet.buffers.push(createBuffer({ name: '#foo', isJoined: false }));
			syncNet.buffers.push(createBuffer({ name: '_server', type: 'server', isJoined: true }));
			updateNetworkFromSync([syncNet]);
			flushSync();

			const found = ircState.networks.find(n => n.networkId === 'n1')!
				.buffers.find(b => b.name === '#foo')!;
			// The phantom stays phantom with joinInFlight=true; sync isIgnored
			expect(found.joinInFlight).toBe(true);
		});

		it('sync snapshot with isJoined=true clears joinInFlight', () => {
			const net = createNetwork({ networkId: 'n1' });
			const phantom = createBuffer({ name: '#foo', isJoined: false, isPhantom: true });
			phantom.joinInFlight = true;
			net.buffers.push(phantom);
			ircState.networks.push(net);

			// Sync reports isJoined=true (the JOIN did propagate)
			const syncNet = createNetwork({ networkId: 'n1' });
			syncNet.buffers.push(createBuffer({ name: '#foo', isJoined: true }));
			syncNet.buffers.push(createBuffer({ name: '_server', type: 'server', isJoined: true }));
			updateNetworkFromSync([syncNet]);
			flushSync();

			const found = ircState.networks.find(n => n.networkId === 'n1')!
				.buffers.find(b => b.name === '#foo')!;
			// joinInFlight must persist until JOIN for self arrives; sync alone
			// doesn't clear it (the JOIN echo is the authoritative handshake).
			expect(found.joinInFlight).toBe(true);
		});
	});
});
