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
	appendMessage,
	incrementUnread,
	checkHighlight,
	setMessages,
	prependMessages,
	trimMessagesIfNeeded,
	updateNetworkFromSync,
	handleConnect,
	updateChannelUsers,
	getSortedMembers,
	updateChannelTopic,
	isMessageUnseen,
	getLastSeenMessage,
	countMessagesBetween,
	countImportantMessagesBetween,
} from './ircStore.svelte';
import { unreadMap, highlightMap, highlightWords, lastSeenMap, bottomSeenMap, setLastSeen, getLastSeen } from './preferences.svelte';
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

	it('does not increment unread for active buffer when message is before lastSeen', () => {
		const net = createNetwork({ networkId: 'net1' });
		const buf = createBuffer({ name: '#chan', unreadCount: 0 });
		net.buffers.push(buf);
		ircState.networks.push(net);

		ircState.activeBuffer.networkId = 'net1';
		ircState.activeBuffer.bufferName = '#chan';
		setLastSeen('net1', '#chan', 5000);

		const msg = createMessage({ t: 4000 });
		appendMessage('net1', '#chan', msg);
		flushSync();

		expect(unreadMap['net1:#chan']).toBeUndefined();
		expect(buf.unreadCount).toBe(0);
	});

	it('increments unread for active buffer when message is after lastSeen', () => {
		const net = createNetwork({ networkId: 'net1' });
		const buf = createBuffer({ name: '#chan', unreadCount: 0 });
		net.buffers.push(buf);
		ircState.networks.push(net);

		ircState.activeBuffer.networkId = 'net1';
		ircState.activeBuffer.bufferName = '#chan';
		setLastSeen('net1', '#chan', 5000);

		const msg = createMessage({ t: 6000 });
		appendMessage('net1', '#chan', msg);
		flushSync();

		// Access buffer through the reactive store (Svelte 5 proxies plain objects)
		const foundNet = ircState.networks.find((n) => n.networkId === 'net1');
		const foundBuf = foundNet?.buffers.find((b) => b.name === '#chan');
		expect(unreadMap['net1:#chan']).toBe(1);
		expect(foundBuf?.unreadCount).toBe(1);
	});
});

describe('trimMessagesIfNeeded', () => {
	it('caps at 350 and trims to 200', () => {
		const msgs = Array.from({ length: 360 }, (_, i) => createMessage({ text: `msg-${i}` }));
		ircState.messages['net1:#chan'] = msgs;

		trimMessagesIfNeeded('net1', '#chan');
		flushSync();

		const list = untrack(() => ircState.messages['net1:#chan']);
		expect(list).toHaveLength(200);
		expect(list[0].text).toBe('msg-160');
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
