import { describe, expect, it, beforeEach, vi } from 'vitest';
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
	markUserDisconnected,
	clearUserDisconnected,
	isUserDisconnected,
	initiateRejoin,
	resetPendingState,
	clearPendingNickChanges, clearPendingMemberRemovals,
	applyRetryStatus,
	applyFail,
} from './ircStore.svelte';
import { reconnectNetwork } from '/src/stores/api';
import { sendRaw } from '/src/stores/wsConnection.svelte.ts';
import { stripPrefix } from '../lib/utils';
import type { Network, Member, RetryStatus, FailInfo } from '../types';
import type { SyncNetwork, SyncBuffer } from './ircStore.svelte';

// ── W3-T04: mock sendRaw + reconnectNetwork so the helper's side effects
// are observable. Use a flat factory like the rest of the test files in
// this repo (BufferHeader.test.ts, ChannelContextMenu.test.ts) —
// vi.importActual at runtime is not allowed because vi.mock factories
// are hoisted and any reference to outer-scope variables is a bug. We
// list every export used by ircStore.svelte.ts as a pass-through stub
// except the two we want to spy on.
vi.mock('/src/stores/api', () => ({
	fetchMe: (() => undefined) as never,
	fetchHealth: (() => undefined) as never,
	loadHistory: (() => undefined) as never,
	loadHistoryWithMeta: (() => undefined) as never,
	reconnectNetwork: vi.fn(async () => undefined),
  clearBacklog: vi.fn(async () => undefined),
	disconnectNetwork: vi.fn(async () => undefined),
	joinChannel: vi.fn(async () => undefined),
	addNetwork: vi.fn(async () => ({} as Record<string, unknown>)),
	updateNetwork: vi.fn(async () => undefined),
	deleteNetwork: vi.fn(async () => undefined),
	archiveChannel: vi.fn(async () => undefined),
	unarchiveChannel: vi.fn(async () => undefined),
	pinChannel: vi.fn(async () => undefined),
	unpinChannel: vi.fn(async () => undefined),
	updateBufferPrefs: vi.fn(async () => undefined),
	hideChannelAPI: vi.fn(async () => undefined),
	unhideChannelAPI: vi.fn(async () => undefined),
	updateInactiveCollapsed: vi.fn(async () => undefined),
	updateCollapsed: vi.fn(async () => undefined),
	normalizeMessage: vi.fn((m: unknown) => m),
	detectEmbeds: (() => undefined) as never,
	uploadAvatar: (() => undefined) as never,
	removeAvatar: (() => undefined) as never,
	fetchUploads: (() => undefined) as never,
	deleteUpload: (() => undefined) as never,
	changePassword: (() => undefined) as never,
	deleteAccount: (() => undefined) as never,
	fetchMeAccount: (() => undefined) as never,
	updateHiddenChannels: (() => undefined) as never,
	updatePinnedChannels: (() => undefined) as never,
	updateArchivedChannels: (() => undefined) as never,
	updateServerlogCollapsed: (() => undefined) as never,
	updateServerlogHidden: (() => undefined) as never,
	updateMembersCollapsed: (() => undefined) as never,
	updateConversationsCollapsed: (() => undefined) as never,
	getNetworks: (() => undefined) as never,
	getSessions: (() => undefined) as never,
	updateNetworkOrder: (() => undefined) as never,
	uploadSnippet: (() => undefined) as never,
}));
vi.mock('/src/stores/wsConnection.svelte.ts', () => ({
	sendRaw: vi.fn(),
	sendMessage: vi.fn(),
	sendEditMessage: vi.fn(),
	sendJson: vi.fn(),
	sendRequest: vi.fn(async () => null),
	requestSync: vi.fn(),
	requestSwitchBuffer: vi.fn(),
	connectWebSocket: vi.fn(),
	disconnectWebSocket: vi.fn(),
	isConnected: vi.fn(() => false),
	setMaxEid: vi.fn(),
	wsState: { value: 'disconnected' },
	maxEidTracker: { value: 0 },
	onStreamState: vi.fn(() => () => {}),
	startXHRFallback: vi.fn(),
	stopXHRFallback: vi.fn(),
}));
import { unreadMap, highlightMap, highlightWords, lastSeenMap, bottomSeenMap, setLastSeen, getLastSeen, hiddenChannelsMap, hideChannel, bufferPrefsMap } from './preferences.svelte';
import { createMessage, createNetwork, createBuffer, createMember } from '../test/factories';
import { buildProcessedBuffer } from '../lib/messageBuilder';

beforeEach(() => {
	ircState.networks.length = 0;
	ircState.activeBuffer.networkId = null;
	ircState.activeBuffer.bufferName = null;
	ircState.messages = {};
	ircState.optimisticMessages.clear();
	clearPendingNickChanges();

	// Reset preference-derived singletons that ircStore writes into
	Object.keys(unreadMap).forEach((k) => delete (unreadMap as Record<string, unknown>)[k]);
	Object.keys(highlightMap).forEach((k) => delete (highlightMap as Record<string, unknown>)[k]);
	Object.keys(lastSeenMap).forEach((k) => delete (lastSeenMap as Record<string, unknown>)[k]);
	Object.keys(bottomSeenMap).forEach((k) => delete (bottomSeenMap as Record<string, unknown>)[k]);
	Object.keys(bufferPrefsMap).forEach((k) => delete (bufferPrefsMap as Record<string, unknown>)[k]);
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
		bufferPrefsMap['net1:#chan'] = { notifyAll: true };

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
		bufferPrefsMap['net1:#chan'] = { notifyAll: true };

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

	it('enriches member realnames from sync caches (bare + prefixed keys)', () => {
		// The engine ships a network-wide `realnames` cache (bare nick keys,
		// from extended-join + WHOIS 311) plus a per-buffer `chan.realnames`
		// subset keyed by the exact raw nick form used in `chan["users"]`
		// (mode prefix + optional userhost). Both must feed member.realname
		// or the author-realname span never renders.
		const existing = createNetwork({ networkId: 'net1' });
		existing.buffers.push(createBuffer({ name: '_server', type: 'server', isJoined: true }));
		const buf = createBuffer({ name: '#chan', isJoined: true });
		buf.users = [
			createMember({ nick: '@alice!alice@example.com', prefix: '@', category: 'OP' }),
			createMember({ nick: 'bob', prefix: '', category: 'MEMBER' }),
		];
		existing.buffers.push(buf);
		ircState.networks.push(existing);

		const incoming = createNetwork({ networkId: 'net1' });
		incoming.buffers.push(createBuffer({ name: '_server', type: 'server', isJoined: true }));
		const incomingBuf = createBuffer({ name: '#chan', isJoined: true });
		// Wire chan["users"]: raw nick strings, not Member objects.
		incomingBuf.users = ['@alice!alice@example.com', 'bob'] as unknown as Member[];
		(incomingBuf as SyncBuffer).realnames = { '@alice!alice@example.com': 'Alice Smith' };
		incoming.buffers.push(incomingBuf);
		(incoming as SyncNetwork).realnames = { alice: 'Alice Smith', bob: 'Bob Builder' };
		(incoming as SyncNetwork).accounts = { bob: 'bob_account' };
		(incoming as SyncNetwork).idents = { bob: 'bob_ident' };
		updateNetworkFromSync([incoming]);
		flushSync();

		const foundNet = ircState.networks.find((n) => n.networkId === 'net1')!;
		// Network-wide cache is persisted on the Network object (MessageRow /
		// BufferHeader fall back to it for nicks outside the member list).
		expect(foundNet.realnames).toEqual({ alice: 'Alice Smith', bob: 'Bob Builder' });
		const foundBuf = foundNet.buffers.find((b) => b.name === '#chan')!;
		// Prefixed+userhost nick resolved via the per-buffer subset.
		const alice = foundBuf.users.find((u) => stripPrefix(u.nick) === 'alice')!;
		expect(alice.realname).toBe('Alice Smith');
		// Bare nick resolved via the network-wide cache.
		const bob = foundBuf.users.find((u) => stripPrefix(u.nick) === 'bob')!;
		expect(bob.realname).toBe('Bob Builder');
		expect(bob.account).toBe('bob_account');
		expect(bob.ident).toBe('bob_ident');
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

	// ── Defense-in-depth C: channelState-drift frontend fallback ──────
	// Reproduces the SuperNets #superbowl symptom — engine loses track
	// of a joined channel in channelState (so the engine's snapshot
	// doesn't ship it in `buffers[]`) but a fresh NAMES reply just
	// arrived, populating the per-channel `users` array. The frontend
	// must still render the room as joined + populated so the user
	// doesn't see a stale "Rejoin" button on an empty member list.
	it('synthesises a joined buffer from channelUsersMap when the engine drift drops it from buffers', () => {
		const incoming = createNetwork({
			networkId: 'supernets',
			name: 'SuperNets',
			connected: true,
			currentNick: 'Zodiac',
		});
		// engine-side: only the four "real" channels survive the
		// channelState.keys-based snapshot iteration. #superbowl is
		// gone from buffers but still has its 175 names in
		// channelUsersMap (top-level payload field).
		incoming.buffers = [
			createBuffer({ name: '_server', type: 'server', isJoined: true }),
			createBuffer({ name: '#dev', isJoined: true, users: [] }),
		];
		(incoming as Network & { channelUsersMap?: Record<string, string[]> })
			.channelUsersMap = {
			'#superbowl': [
				'+alice!~alice@host1',
				'@bob!~bob@host2',
				'Zodiac',
			],
		};
		updateNetworkFromSync([incoming]);
		flushSync();

		const net = ircState.networks.find((n) => n.networkId === 'supernets');
		const bufNames = net?.buffers.map((b) => b.name) ?? [];
		expect(bufNames).toContain('#superbowl');
		const superbowl = net?.buffers.find((b) => b.name === '#superbowl');
		expect(superbowl?.isJoined).toBe(true);
		expect(superbowl?.type).toBe('channel');
		// Members are copied over (string[] → Member[] via normalizeUser).
		expect(superbowl?.users.length).toBe(3);
		// Normalise nick names so prefix chars (@/+) on the engine-side
		// strings survive the snapshot round-trip — same parity the
		// MemberList needs for the category headers (Ops/Voiced).
		const bobs = superbowl?.users.filter(
			u => stripPrefix(u.nick) === 'bob');
		expect(bobs?.[0]?.prefix).toBe('@');
		const alices = superbowl?.users.filter(
			u => stripPrefix(u.nick) === 'alice');
		expect(alices?.[0]?.prefix).toBe('+');
		// Self-nick is also re-added (NAMES didn't include it
		// in the drift case, just like on some IRCds — mirrors the
		// existing isJoined===true re-add guard for normal syncs).
		const self = superbowl?.users.filter(
			u => stripPrefix(u.nick) === 'Zodiac');
		expect(self).toBeDefined();
	});

	it('does NOT synthesise when the network is disconnected (server no longer believes we are in the room)', () => {
		const incoming = createNetwork({
			networkId: 'supernets',
			connected: false,
			currentNick: 'Zodiac',
		});
		incoming.buffers = [
			createBuffer({ name: '_server', type: 'server', isJoined: true }),
		];
		(incoming as Network & { channelUsersMap?: Record<string, string[]> })
			.channelUsersMap = { '#superbowl': ['+alice'] };
		updateNetworkFromSync([incoming]);
		flushSync();

		const net = ircState.networks.find((n) => n.networkId === 'supernets');
		const bufNames = net?.buffers.map((b) => b.name) ?? [];
		expect(bufNames).not.toContain('#superbowl');
	});

	it('does NOT synthesise from an empty NAMES reply (legal but rare — better to not phantom-adopt)', () => {
		const incoming = createNetwork({
			networkId: 'supernets',
			connected: true,
			currentNick: 'Zodiac',
		});
		incoming.buffers = [
			createBuffer({ name: '_server', type: 'server', isJoined: true }),
		];
		(incoming as Network & { channelUsersMap?: Record<string, string[]> })
			.channelUsersMap = { '#superbowl': [] };
		updateNetworkFromSync([incoming]);
		flushSync();

		const net = ircState.networks.find((n) => n.networkId === 'supernets');
		const bufNames = net?.buffers.map((b) => b.name) ?? [];
		expect(bufNames).not.toContain('#superbowl');
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

	it('fills realname from the network cache on 353', () => {
		// NAMES itself doesn't carry realnames; the 353 handler must look
		// them up in the engine's network-wide cache (which is populated by
		// extended-join / WHOIS and shipped with every sync) so the member
		// roster shows the real name immediately.
		const net = createNetwork({ networkId: 'net1' });
		net.realnames = { alice: 'Alice Smith', bob: 'Bob' };
		net.buffers.push(createBuffer({ name: '#chan' }));
		ircState.networks.push(net);

		updateChannelUsers('net1', '#chan', '353', '', ['#chan', '@alice bob']);
		flushSync();

		const foundBuf = ircState.networks.find((n) => n.networkId === 'net1')!
			.buffers.find((b) => b.name === '#chan')!;
		const alice = foundBuf.users.find((u) => stripPrefix(u.nick) === 'alice')!;
		expect(alice.realname).toBe('Alice Smith');
		const bob = foundBuf.users.find((u) => stripPrefix(u.nick) === 'bob')!;
		expect(bob.realname).toBe('Bob');
	});

	it('fills realname from the network cache on JOIN without extended-join', () => {
		const net = createNetwork({ networkId: 'net1', currentNick: 'me' });
		net.realnames = { charlie: 'Charlie Brown' };
		net.buffers.push(createBuffer({ name: '#chan' }));
		ircState.networks.push(net);

		updateChannelUsers('net1', '#chan', 'JOIN', 'charlie', ['#chan'], ':charlie!c@host');
		flushSync();

		const foundBuf = ircState.networks.find((n) => n.networkId === 'net1')!
			.buffers.find((b) => b.name === '#chan')!;
		const charlie = foundBuf.users.find((u) => stripPrefix(u.nick) === 'charlie')!;
		expect(charlie.realname).toBe('Charlie Brown');
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

		// User types /nick newnick — optimistic update fires. The
		// pendingSelfNickChange tracker is what tells the sync handler
		// "this value is in flight, don't clobber it".
		net.currentNick = 'newnick';
		net.pendingSelfNickChange = { oldNick: 'oldnick', newNick: 'newnick', setAt: Date.now() };

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

	it('does not revert members list nick from sync after optimistic /nick', () => {
		// Regression: the typing-area `currentNick` was protected from sync
		// overwrite (see "does not overwrite currentNick from sync snapshot
		// after optimistic /nick" above), but `buf.users[i].nick` was NOT.
		// A sync snapshot taken before the engine saw the nick change
		// would revert the members-list entry to the old nick even though
		// `currentNick` was already correct. This test guards the
		// pending-nick-change bookkeeping introduced to fix that.
		const net = createNetwork({ networkId: 'net1', nick: 'oldnick', currentNick: 'oldnick' });
		const buf = createBuffer({
			name: '#chan',
			users: [createMember({ nick: 'oldnick' })],
		});
		net.buffers.push(buf);
		ircState.networks.push(net);

		// Live NICK event — user typed /nick newnick
		updateChannelUsers('net1', '#chan', 'NICK', 'oldnick', ['oldnick', 'newnick']);
		flushSync();

		// The handler set pendingSelfNickChange? No — only the slash
		// command / form / prompt do that. The live NICK echo alone
		// doesn't track pending (the engine's echo IS the
		// authoritative signal). The pendingNickChanges map (per-buffer
		// nick patch) is what protects buf.users across sync.

		// Pre-change sync snapshot arrives carrying the old nick (engine
		// hadn't observed the rename yet). Must NOT revert members list.
		const syncPayload = [
			createNetwork({
				networkId: 'net1',
				nick: 'oldnick',
				currentNick: 'oldnick',
				buffers: [{
					name: '#chan',
					users: [createMember({ nick: 'oldnick' })],
				}],
			}),
		];
		updateNetworkFromSync(syncPayload);
		flushSync();

		const foundNet = ircState.networks.find((n) => n.networkId === 'net1');
		const foundBuf = foundNet?.buffers.find((b) => b.name === '#chan');
		expect(foundBuf?.users[0].nick).toBe('newnick');
		expect(foundNet?.currentNick).toBe('newnick');
	});

	it('clears pending nick change once a sync confirms the new nick', () => {
		const net = createNetwork({ networkId: 'net1', nick: 'oldnick', currentNick: 'oldnick' });
		const buf = createBuffer({
			name: '#chan',
			users: [createMember({ nick: 'oldnick' })],
		});
		net.buffers.push(buf);
		ircState.networks.push(net);

		updateChannelUsers('net1', '#chan', 'NICK', 'oldnick', ['oldnick', 'newnick']);
		flushSync();

		// First sync: stale oldnick — should be ignored (pending).
		updateNetworkFromSync([
			createNetwork({
				networkId: 'net1',
				nick: 'oldnick',
				currentNick: 'oldnick',
				buffers: [{ name: '#chan', users: [createMember({ nick: 'oldnick' })] }],
			}),
		]);
		flushSync();

		// Second sync: now reflects the new nick — pending should clear.
		updateNetworkFromSync([
			createNetwork({
				networkId: 'net1',
				nick: 'newnick',
				currentNick: 'newnick',
				buffers: [{ name: '#chan', users: [createMember({ nick: 'newnick' })] }],
			}),
		]);
		flushSync();

		const foundNet = ircState.networks.find((n) => n.networkId === 'net1');
		const foundBuf = foundNet?.buffers.find((b) => b.name === '#chan');
		expect(foundBuf?.users[0].nick).toBe('newnick');
	});

	describe('self nick-change handling (optimistic + echo + rejection)', () => {
		it('updates currentNick on NICK echo when pendingSelfNickChange matches', () => {
			// Regression for: user types /nick newnick → optimistic update
			// fires first (currentNick=newnick) → echo arrives with the OLD
			// nick in the prefix. The plain `nick === net.currentNick`
			// check fails because currentNick has already moved; the
			// pendingSelfNickChange tracker is the authoritative path.
			const net = createNetwork({ networkId: 'net1', currentNick: 'oldnick' });
			const buf = createBuffer({
				name: '#chan',
				users: [createMember({ nick: 'oldnick' })],
			});
			net.buffers.push(buf);
			net.pendingSelfNickChange = { oldNick: 'oldnick', newNick: 'newnick', setAt: Date.now() };
			net.currentNick = 'newnick';
			ircState.networks.push(net);

			updateChannelUsers('net1', '#chan', 'NICK', 'oldnick', ['newnick']);
			flushSync();

			const foundNet = ircState.networks.find((n) => n.networkId === 'net1');
			expect(foundNet?.currentNick).toBe('newnick');
			expect(foundNet?.pendingSelfNickChange).toBeUndefined();
		});

		it('matches pendingSelfNickChange case-insensitively (IRC casemap)', () => {
			// RFC 1459 says nicks are case-insensitive; "Alice" and
			// "alice" are the same identity. A /nick from "alice" to
			// "Alice" must still be detected as self even though the
			// strings differ.
			const net = createNetwork({ networkId: 'net1', currentNick: 'alice' });
			const buf = createBuffer({ name: '#chan', users: [createMember({ nick: 'alice' })] });
			net.buffers.push(buf);
			net.pendingSelfNickChange = { oldNick: 'alice', newNick: 'Alice', setAt: Date.now() };
			net.currentNick = 'Alice';
			ircState.networks.push(net);

			updateChannelUsers('net1', '#chan', 'NICK', 'alice', ['Alice']);
			flushSync();

			const foundNet = ircState.networks.find((n) => n.networkId === 'net1');
			expect(foundNet?.currentNick).toBe('Alice');
			expect(foundNet?.pendingSelfNickChange).toBeUndefined();
		});

		it('reverts currentNick on 433 (nickname in use) rejection', () => {
			// Regression for: user types /nick Zodiac → optimistic update
			// sets currentNick='Zodiac' → server rejects with 433 because
			// the nick is taken → without a 433 handler, currentNick
			// stays stuck on the rejected value until page reload.
			const net = createNetwork({ networkId: 'net1', currentNick: 'Zodiac_' });
			net.buffers.push(createBuffer({ name: '_server', type: 'server' }));
			net.pendingSelfNickChange = { oldNick: 'Zodiac_', newNick: 'Zodiac', setAt: Date.now() };
			net.currentNick = 'Zodiac';
			ircState.networks.push(net);

			// 433 is delivered to the _server buffer (server numeric).
			updateChannelUsers('net1', '_server', '433', '', ['Zodiac', 'Nickname is already in use']);
			flushSync();

			const foundNet = ircState.networks.find((n) => n.networkId === 'net1');
			expect(foundNet?.currentNick).toBe('Zodiac_');
			expect(foundNet?.pendingSelfNickChange).toBeUndefined();
		});

		it('reverts currentNick on 432 (erroneous nickname) rejection', () => {
			const net = createNetwork({ networkId: 'net1', currentNick: 'goodname' });
			net.buffers.push(createBuffer({ name: '_server', type: 'server' }));
			net.pendingSelfNickChange = { oldNick: 'goodname', newNick: 'bad!name', setAt: Date.now() };
			net.currentNick = 'bad!name';
			ircState.networks.push(net);

			updateChannelUsers('net1', '_server', '432', '', ['bad!name', 'Erroneous nickname']);
			flushSync();

			const foundNet = ircState.networks.find((n) => n.networkId === 'net1');
			expect(foundNet?.currentNick).toBe('goodname');
			expect(foundNet?.pendingSelfNickChange).toBeUndefined();
		});

		it('does not revert currentNick on 433 if no pending self change', () => {
			// 433 unrelated to a /nick we initiated (e.g. server probe
			// response from a different network) must not clobber an
			// unrelated currentNick.
			const net = createNetwork({ networkId: 'net1', currentNick: 'mynick' });
			net.buffers.push(createBuffer({ name: '_server', type: 'server' }));
			ircState.networks.push(net);

			updateChannelUsers('net1', '_server', '433', '', ['othernick', 'Nickname is already in use']);
			flushSync();

			const foundNet = ircState.networks.find((n) => n.networkId === 'net1');
			expect(foundNet?.currentNick).toBe('mynick');
		});

		it('sync clears pendingSelfNickChange when engine agrees with optimistic value', () => {
			// The user typed /nick, the optimistic update fired, and the
			// engine snapshot has now caught up to the new value. The
			// pending tracker is no longer needed — clear it so subsequent
			// flows don't think we're still mid-/nick.
			const net = createNetwork({ networkId: 'net1', currentNick: 'Zodiac' });
			net.pendingSelfNickChange = { oldNick: 'Zodiac_', newNick: 'Zodiac', setAt: Date.now() };
			ircState.networks.push(net);

			updateNetworkFromSync([
				createNetwork({ networkId: 'net1', nick: 'Zodiac', currentNick: 'Zodiac' }),
			]);
			flushSync();

			const foundNet = ircState.networks.find((n) => n.networkId === 'net1');
			expect(foundNet?.currentNick).toBe('Zodiac');
			expect(foundNet?.pendingSelfNickChange).toBeUndefined();
		});

		it('sync keeps optimistic currentNick while a /nick is in flight', () => {
			const net = createNetwork({ networkId: 'net1', currentNick: 'Zodiac_' });
			net.pendingSelfNickChange = { oldNick: 'Zodiac_', newNick: 'Zodiac', setAt: Date.now() };
			net.currentNick = 'Zodiac';
			ircState.networks.push(net);

			// Stale sync carrying the old nick — must NOT clobber the
			// optimistic value while the change is in flight.
			updateNetworkFromSync([
				createNetwork({ networkId: 'net1', nick: 'Zodiac_', currentNick: 'Zodiac_' }),
			]);
			flushSync();

			const foundNet = ircState.networks.find((n) => n.networkId === 'net1');
			expect(foundNet?.currentNick).toBe('Zodiac');
		});
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
		// Burst-order guard: the live path now sorts by t→eid so ascii art
		// pasted as 10 lines with identical t renders deterministically.
		// An older batch (50,60) appended after 100 is merged chronologically.
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
		expect(eids).toEqual([50, 60, 100]);
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

		// Real IRC wire format: MODE <channel> <modes> <target>...
		// The previous test used ['+o', 'alice'] which masked the bug
		// where params[0] was being treated as the mode string instead
		// of params[1].
		updateChannelUsers('net1', '#chan', 'MODE', '', ['#chan', '+o', 'alice']);
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

// ── W7-T02: orphan reconciliation threshold + activity guard ──
// Regression tests for the "thinks we're not in the room" bug reported
// on #superbowl. The engine's channelState snapshot runs every ~10s and
// can lag a fresh JOIN by one cycle. The old code flipped isJoined:
// true → false on the very first missed sync, which surfaced a bogus
// Rejoin button in BufferHeader. Now:
//   1. Each missed sync increments `syncMissedCount`
//   2. The flip only fires after ORPHAN_FLIP_THRESHOLD (3) consecutive
//      missed syncs
//   3. The flip is skipped entirely if the buffer has any local message
//      within RECENT_ACTIVITY_GUARD_MS (5 min) — the user is actively
//      chatting, so the engine snapshot is stale
//   4. The counter resets to 0 when the channel appears in a sync
describe('orphan reconciliation (W7-T02)', () => {
	function getBuf(networkId: string, name: string): Buffer | undefined {
		return ircState.networks
			.find((n) => n.networkId === networkId)
			?.buffers.find((b) => b.name === name);
	}

	function syncWithout(networkId: string, except: Set<string>): void {
		// A sync that omits every channel in `except`. This simulates the
		// engine snapshot being one cycle behind a recent JOIN.
		const incoming = createNetwork({ networkId });
		// Always include the server log so it doesn't trip the orphan loop.
		incoming.buffers.push(createBuffer({ name: '_server', type: 'server', isJoined: true }));
		updateNetworkFromSync([incoming]);
		flushSync();
	}

	function syncWith(networkId: string, channels: string[]): void {
		const incoming = createNetwork({ networkId });
		incoming.buffers.push(createBuffer({ name: '_server', type: 'server', isJoined: true }));
		for (const name of channels) {
			incoming.buffers.push(createBuffer({ name, isJoined: true }));
		}
		updateNetworkFromSync([incoming]);
		flushSync();
	}

	it('a single missed sync does NOT flip isJoined to false (regression for #superbowl)', () => {
		const net = createNetwork({ networkId: 'net1' });
		const buf = createBuffer({ name: '#superbowl', isJoined: true });
		net.buffers.push(buf);
		ircState.networks.push(net);

		// First sync after the JOIN: the channel is missing from the
		// engine's channelState snapshot (engine is one tick behind).
		syncWithout('net1', new Set());
		flushSync();

		const found = getBuf('net1', '#superbowl');
		expect(found?.isJoined).toBe(true); // NOT flipped
		expect(found?.syncMissedCount).toBe(1);
	});

	it('two consecutive missed syncs still do NOT flip isJoined', () => {
		const net = createNetwork({ networkId: 'net1' });
		net.buffers.push(createBuffer({ name: '#superbowl', isJoined: true }));
		ircState.networks.push(net);

		syncWithout('net1', new Set());
		syncWithout('net1', new Set());
		flushSync();

		const found = getBuf('net1', '#superbowl');
		expect(found?.isJoined).toBe(true); // still NOT flipped
		expect(found?.syncMissedCount).toBe(2);
	});

	it('three consecutive missed syncs flip isJoined to false (threshold reached)', () => {
		const net = createNetwork({ networkId: 'net1' });
		net.buffers.push(createBuffer({ name: '#superbowl', isJoined: true }));
		ircState.networks.push(net);

		syncWithout('net1', new Set());
		syncWithout('net1', new Set());
		syncWithout('net1', new Set());
		flushSync();

		const found = getBuf('net1', '#superbowl');
		expect(found?.isJoined).toBe(false); // NOW flipped
		expect(found?.syncMissedCount).toBe(3);
	});

	it('syncMissedCount resets to 0 when the channel reappears in a sync', () => {
		const net = createNetwork({ networkId: 'net1' });
		net.buffers.push(createBuffer({ name: '#superbowl', isJoined: true }));
		ircState.networks.push(net);

		// Build up the counter
		syncWithout('net1', new Set());
		syncWithout('net1', new Set());
		const found = getBuf('net1', '#superbowl');
		expect(found?.syncMissedCount).toBe(2);

		// Engine snapshot catches up
		syncWith('net1', ['#superbowl']);
		expect(found?.syncMissedCount).toBe(0);
		expect(found?.isJoined).toBe(true);
	});

	it('activity guard: ANY local message prevents the flip even after threshold', () => {
		// User has been in #superbowl at some point (we have a local
		// message in the buffer). The engine snapshot is just stale (lost
		// track after a restart, network glitch, handoff race, etc).
		// Don't flip isJoined no matter how many syncs miss — otherwise
		// the user sees a bogus "Rejoin" button even though they're still
		// chatting in the room. A genuine leave (PART/KICK for self)
		// already clears isJoined directly via updateChannelUsers, so the
		// orphan flip would only catch the "left via another client"
		// scenario — which is rare and the user can always rejoin.
		const net = createNetwork({ networkId: 'net1' });
		net.buffers.push(createBuffer({ name: '#superbowl', isJoined: true }));
		ircState.networks.push(net);

		// Seed the buffer with a recent PRIVMSG.
		setMessages('net1', '#superbowl', [
			createMessage({
				command: 'PRIVMSG',
				nick: 'alice',
				text: 'hello',
				t: Date.now(),
			}),
		]);

		// Miss the threshold by 2x — still no flip.
		for (let i = 0; i < 10; i++) {
			syncWithout('net1', new Set());
		}
		flushSync();

		const found = getBuf('net1', '#superbowl');
		expect(found?.isJoined).toBe(true); // activity guard wins
		expect(found?.syncMissedCount).toBe(10);
	});

	it('joinInFlight=true still protects against the orphan flip (existing guard preserved)', () => {
		const net = createNetwork({ networkId: 'net1' });
		const buf = createBuffer({ name: '#newchan', isJoined: true, joinInFlight: true });
		net.buffers.push(buf);
		ircState.networks.push(net);

		// Miss the threshold many times
		for (let i = 0; i < 10; i++) {
			syncWithout('net1', new Set());
		}
		flushSync();

		const found = getBuf('net1', '#newchan');
		expect(found?.isJoined).toBe(true); // joinInFlight guard wins
		expect(found?.syncMissedCount).toBeUndefined(); // not even incremented
	});

	it('activity guard: old messages (10 min ago) still protect — any local message wins', () => {
		// Regression for #superbowl-style "I went idle for a bit and came
		// back to a Rejoin button" bug. The original guard checked only
		// the last 5 minutes, which let the flip fire during quiet
		// periods. Now any message in the buffer's history protects the
		// channel — the engine snapshot being missing for 3 cycles is no
		// longer enough to declare the user has left.
		const net = createNetwork({ networkId: 'net1' });
		net.buffers.push(createBuffer({ name: '#superbowl', isJoined: true }));
		ircState.networks.push(net);

		// Seed with a message from 10 minutes ago (was previously outside
		// the 5-min guard, now still counts).
		setMessages('net1', '#superbowl', [
			createMessage({
				command: 'PRIVMSG',
				nick: 'alice',
				text: 'old message',
				t: Date.now() - 10 * 60 * 1000,
			}),
		]);

		// Miss the threshold many times.
		for (let i = 0; i < 5; i++) {
			syncWithout('net1', new Set());
		}
		flushSync();

		const found = getBuf('net1', '#superbowl');
		// ANY local message wins — old message still protects.
		expect(found?.isJoined).toBe(true);
		expect(found?.syncMissedCount).toBe(5);
	});

	it('activity guard: empty buffer with no messages still flips after threshold', () => {
		// If the buffer has never had any local messages, the engine
		// snapshot is the only signal we have. After the threshold, trust
		// the engine and mark the channel as parted.
		const net = createNetwork({ networkId: 'net1' });
		net.buffers.push(createBuffer({ name: '#newchan', isJoined: true }));
		ircState.networks.push(net);

		syncWithout('net1', new Set());
		syncWithout('net1', new Set());
		syncWithout('net1', new Set());
		flushSync();

		const found = getBuf('net1', '#newchan');
		expect(found?.isJoined).toBe(false);
		expect(found?.syncMissedCount).toBe(3);
	});

	it('_server buffer is excluded from the orphan reconciliation', () => {
		// _server should always be present (it's the connection log) — but
		// even if it weren't, the orphan loop skips it explicitly.
		const net = createNetwork({ networkId: 'net1' });
		net.buffers.push(createBuffer({ name: '_server', type: 'server', isJoined: true }));
		ircState.networks.push(net);

		syncWithout('net1', new Set());
		syncWithout('net1', new Set());
		syncWithout('net1', new Set());
		syncWithout('net1', new Set());
		flushSync();

		const found = getBuf('net1', '_server');
		expect(found?.isJoined).toBe(true);
	});
});

// ── Self-nick presence in member list ──
//
// Regression for: navigating to /irc/<network>/channel/<chan> (e.g. via URL)
// shows the channel header as joined (isJoined=true) but the user doesn't
// appear in the members list. Root cause: the sync handler unconditionally
// overwrites buf.users with the incoming snapshot, but the self-nick
// re-add guard only fires when there's a pending join (pendingIsJoined ||
// joinInFlight). After the initial join completes and those flags clear,
// a sync snapshot that omits self-nick (stale engine snapshot, race with
// RPL_NAMREPLY on some IRCds, the user joined from another client, etc.)
// permanently wipes the self-nick from the member list — there's no
// further mechanism to re-add it.
describe('self-nick presence in member list (W8-T01)', () => {
	function getBuf(networkId: string, name: string): Buffer | undefined {
		return ircState.networks
			.find((n) => n.networkId === networkId)
			?.buffers.find((b) => b.name === name);
	}

	it('sync restores self-nick when the snapshot omits it but buffer is joined', () => {
		// User has been in #superbowl for a while. pendingIsJoined/joinInFlight
		// are both cleared. A sync arrives with the channel's userlist but
		// self-nick is missing from the engine's channelUsers (e.g. the engine
		// snapshot was taken just before the user's own JOIN echoed through
		// to channelUsers, or the user joined from another client and the
		// engine doesn't track them in channelUsers yet).
		const net = createNetwork({ networkId: 'net1', currentNick: 'Zodiac' });
		const buf = createBuffer({ name: '#superbowl', isJoined: true });
		buf.users = [
			createMember({ nick: 'alice' }),
			createMember({ nick: 'bob' }),
		];
		net.buffers.push(buf);
		ircState.networks.push(net);

		const incoming = createNetwork({ networkId: 'net1', currentNick: 'Zodiac' });
		const incomingBuf = createBuffer({ name: '#superbowl', isJoined: true });
		incomingBuf.users = [
			createMember({ nick: 'alice' }),
			createMember({ nick: 'bob' }),
			// no Zodiac — simulates the missing-self case
		];
		incoming.buffers.push(incomingBuf);
		updateNetworkFromSync([incoming]);
		flushSync();

		const found = getBuf('net1', '#superbowl');
		const bareNicks = found?.users.map((u) => stripPrefix(u.nick)) ?? [];
		expect(bareNicks).toContain('Zodiac');
	});

	it('sync does NOT re-add self-nick when buffer is not joined', () => {
		// Inverse case: user has parted from #superbowl. The sync should NOT
		// resurrect a ghost self-nick in the userlist.
		const net = createNetwork({ networkId: 'net1', currentNick: 'Zodiac' });
		const buf = createBuffer({ name: '#superbowl', isJoined: false });
		buf.users = [createMember({ nick: 'alice' })];
		net.buffers.push(buf);
		ircState.networks.push(net);

		const incoming = createNetwork({ networkId: 'net1', currentNick: 'Zodiac' });
		const incomingBuf = createBuffer({ name: '#superbowl', isJoined: false });
		incomingBuf.users = [createMember({ nick: 'alice' })];
		incoming.buffers.push(incomingBuf);
		updateNetworkFromSync([incoming]);
		flushSync();

		const found = getBuf('net1', '#superbowl');
		const bareNicks = found?.users.map((u) => stripPrefix(u.nick)) ?? [];
		expect(bareNicks).not.toContain('Zodiac');
	});

	it('sync does NOT duplicate self-nick when both lists include it', () => {
		const net = createNetwork({ networkId: 'net1', currentNick: 'Zodiac' });
		const buf = createBuffer({ name: '#superbowl', isJoined: true });
		buf.users = [
			createMember({ nick: 'alice' }),
			createMember({ nick: 'Zodiac' }),
		];
		net.buffers.push(buf);
		ircState.networks.push(net);

		const incoming = createNetwork({ networkId: 'net1', currentNick: 'Zodiac' });
		const incomingBuf = createBuffer({ name: '#superbowl', isJoined: true });
		incomingBuf.users = [
			createMember({ nick: 'alice' }),
			createMember({ nick: 'Zodiac' }),
		];
		incoming.buffers.push(incomingBuf);
		updateNetworkFromSync([incoming]);
		flushSync();

		const found = getBuf('net1', '#superbowl');
		const selfCount = (found?.users ?? []).filter((u) => stripPrefix(u.nick) === 'Zodiac').length;
		expect(selfCount).toBe(1);
	});

	it('sync preserves prefix from incoming member list (e.g. @Zodiac if self is op)', () => {
		// If the engine's snapshot DOES include self-nick (with or without a
		// prefix), the sync must use that — don't replace it with a bare entry.
		// This protects the member list from losing its op/voice indicator
		// when the self-nick is in the snapshot.
		const net = createNetwork({ networkId: 'net1', currentNick: 'Zodiac' });
		const buf = createBuffer({ name: '#superbowl', isJoined: true });
		buf.users = [createMember({ nick: 'Zodiac' })];
		net.buffers.push(buf);
		ircState.networks.push(net);

		const incoming = createNetwork({ networkId: 'net1', currentNick: 'Zodiac' });
		const incomingBuf = createBuffer({ name: '#superbowl', isJoined: true });
		incomingBuf.users = [createMember({ nick: '@Zodiac', prefix: '@', category: 'OP' })];
		incoming.buffers.push(incomingBuf);
		updateNetworkFromSync([incoming]);
		flushSync();

		const found = getBuf('net1', '#superbowl');
		const zodiac = found?.users.find((u) => stripPrefix(u.nick) === 'Zodiac');
		expect(zodiac?.nick).toBe('@Zodiac');
		expect(zodiac?.prefix).toBe('@');
	});
});

describe('phantom buffers (URL nav auto-create)', () => {
  beforeEach(() => clearPendingMemberRemovals());
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

		// Regression for the persistent "Rejoin" button on #superbowl:
		// when the user is already joined server-side and the frontend
		// initiates a JOIN anyway (URL nav, click on inactive channel),
		// the server returns ERR_USERONCHANNEL (443) instead of a JOIN
		// echo. updateChannelUsers for 443 does set isJoined=true and
		// clears joinInFlight, but if the 443 frame is dropped or arrives
		// AFTER the next sync, the frontend's joinInFlight flag stays
		// stuck true forever and the sync handler never sets isJoined=true
		// (the joinInFlight guard short-circuits the phantom branch).
		// When the engine snapshot reports the channel as joined, that IS
		// authoritative — the JOIN succeeded. Adopt and clear all the
		// in-flight flags so the buffer stops showing "Rejoin".
		it('sync snapshot with isJoined=true clears joinInFlight on phantom', () => {
			const net = createNetwork({ networkId: 'n1' });
			const phantom = createBuffer({ name: '#superbowl', isJoined: false, isPhantom: true });
			phantom.joinInFlight = true;
			phantom.pendingIsJoined = true;
			phantom.pendingConfirmations = 2;
			net.buffers.push(phantom);
			ircState.networks.push(net);

			// Sync reports isJoined=true (the engine confirms we're joined)
			const syncNet = createNetwork({ networkId: 'n1' });
			syncNet.buffers.push(createBuffer({ name: '#superbowl', isJoined: true }));
			syncNet.buffers.push(createBuffer({ name: '_server', type: 'server', isJoined: true }));
			updateNetworkFromSync([syncNet]);
			flushSync();

			const found = ircState.networks.find(n => n.networkId === 'n1')!
				.buffers.find(b => b.name === '#superbowl')!;
			// Engine confirms we're joined — adopt isJoined=true and clear
			// all in-flight flags. The sync IS authoritative for "are we
			// joined" once the engine's snapshot reflects the JOIN.
			expect(found.isJoined).toBe(true);
			expect(found.isPhantom).toBe(false);
			expect(found.joinInFlight).toBe(false);
			expect(found.pendingIsJoined).toBeUndefined();
			expect(found.pendingConfirmations).toBeUndefined();
		});

		it('sync snapshot with isJoined=true clears joinInFlight on non-phantom buffer', () => {
			// Same regression as above but the buffer is no longer a phantom
			// (e.g. the user previously joined, the buffer has full state,
			// then they re-joined via the Rejoin button).
			const net = createNetwork({ networkId: 'n1' });
			const buf = createBuffer({ name: '#superbowl', isJoined: false });
			buf.joinInFlight = true;
			buf.pendingIsJoined = true;
			buf.pendingConfirmations = 2;
			net.buffers.push(buf);
			ircState.networks.push(net);

			const syncNet = createNetwork({ networkId: 'n1' });
			syncNet.buffers.push(createBuffer({ name: '#superbowl', isJoined: true }));
			syncNet.buffers.push(createBuffer({ name: '_server', type: 'server', isJoined: true }));
			updateNetworkFromSync([syncNet]);
			flushSync();

			const found = ircState.networks.find(n => n.networkId === 'n1')!
				.buffers.find(b => b.name === '#superbowl')!;
			expect(found.isJoined).toBe(true);
			expect(found.joinInFlight).toBe(false);
			expect(found.pendingIsJoined).toBeUndefined();
		});
	});

	describe('initiateRejoin (W3-T04 canonical rejoin helper)', () => {
		// The mocked sendRaw + reconnectNetwork (hoisted above) are spies
		// these tests observe. Each test below re-creates a fresh
		// network + buffer via setupBuf().

		function setupBuf(opts: {
			isJoined?: boolean;
			joinInFlight?: boolean;
			joinError?: string | null;
			users?: ReturnType<typeof createMember>[];
			connected?: boolean;
		} = {}) {
			const net = createNetwork({
				networkId: 'n1',
				name: 'net',
				connected: opts.connected ?? true,
				currentNick: 'me',
			});
			const buf = createBuffer({
				name: '#test',
				isJoined: opts.isJoined ?? true,
				users: opts.users as unknown as ReturnType<typeof createMember>[] | undefined,
			});
			if (opts.joinInFlight !== undefined) buf.joinInFlight = opts.joinInFlight;
			if (opts.joinError !== undefined) (buf as { joinError?: string | null }).joinError = opts.joinError;
			net.buffers.push(buf);
			ircState.networks.push(net);
			return buf;
		}

		beforeEach(() => {
			vi.mocked(sendRaw).mockClear();
			vi.mocked(reconnectNetwork).mockClear();
		});

		// ── T1: state-machine quartet ──────────────────────────────────────────
		it('T1: sets the four-flag state quartet (joinError, joinInFlight, pendingIsJoined, pendingConfirmations)', () => {
			setupBuf({ isJoined: false });
			initiateRejoin('n1', '#test');
			flushSync();
			const buf = findBuf('n1', '#test')!;
			expect(buf.joinError).toBe(null);
			expect(buf.joinInFlight).toBe(true);
			expect(buf.pendingIsJoined).toBe(true);
			expect(buf.pendingConfirmations).toBe(2);
		});

		// ── T2: markJoinPending + recordJoin + sendRaw called exactly once ──
		it('T2: calls markJoinPending + recordJoin + sendRaw exactly once', () => {
			setupBuf();
			initiateRejoin('n1', '#test');
			flushSync();
			// markJoinPending observed via pendingJoins dedup set membership
			expect(isJoinPending('n1', '#test')).toBe(true);
			expect(vi.mocked(sendRaw)).toHaveBeenCalledTimes(1);
			expect(vi.mocked(sendRaw)).toHaveBeenCalledWith('n1', 'JOIN #test');
			// recordJoin observed via activeJoinList membership
			expect(activeJoinList.has('n1:#test')).toBe(true);
		});

		// ── T3: allowReconnect=false on disconnected network does NOT reconnect ──
		it('T3: allowReconnect=false on disconnected network does NOT call reconnectNetwork', () => {
			setupBuf({ connected: false });
			initiateRejoin('n1', '#test', { allowReconnect: false });
			flushSync();
			expect(vi.mocked(reconnectNetwork)).not.toHaveBeenCalled();
		});

		// ── T4: allowReconnect=true on connected network does NOT reconnect ──
		it('T4: allowReconnect=true on connected network does NOT call reconnectNetwork', () => {
			setupBuf({ connected: true });
			initiateRejoin('n1', '#test', { allowReconnect: true });
			flushSync();
			expect(vi.mocked(reconnectNetwork)).not.toHaveBeenCalled();
		});

		// ── T5: allowReconnect=true on disconnected network DOES reconnect ──
		it('T5: allowReconnect=true on disconnected network DOES call reconnectNetwork', () => {
			setupBuf({ connected: false });
			initiateRejoin('n1', '#test', { allowReconnect: true });
			flushSync();
			expect(vi.mocked(reconnectNetwork)).toHaveBeenCalledTimes(1);
			expect(vi.mocked(reconnectNetwork)).toHaveBeenCalledWith('n1');
		});

		// ── T6: idempotent under isJoinPending ────────────────────────────────
		it('T6: when isJoinPending is true a second call is a no-op (idempotent)', () => {
			setupBuf();
			initiateRejoin('n1', '#test');
			flushSync();
			const callsAfterFirst = vi.mocked(sendRaw).mock.calls.length;
			const reconnectCallsAfterFirst = vi.mocked(reconnectNetwork).mock.calls.length;
			initiateRejoin('n1', '#test');
			initiateRejoin('n1', '#test');
			flushSync();
			// Second and third calls must be no-ops — sendRaw and reconnectNetwork
			// were already called at most once and must not increment.
			expect(vi.mocked(sendRaw).mock.calls.length).toBe(callsAfterFirst);
			expect(vi.mocked(reconnectNetwork).mock.calls.length).toBe(reconnectCallsAfterFirst);
		});

		// ── T7: pre-pop self-nick + survives 353 with prefixed form ──────────
		it('T7: pre-populates self-nick at click time and survives 353 with prefixed form', () => {
			setupBuf({ users: [] });
			initiateRejoin('n1', '#test');
			flushSync();
			let buf = findBuf('n1', '#test')!;
			// Exactly one entry for `me`
			expect(buf.users.filter((u: { nick: string }) => stripPrefix(u.nick) === 'me')).toHaveLength(1);

			// Simulate JOIN-self echo — stripPrefix-safe dedup means users array
			// does NOT grow with a duplicate `me` entry.
			updateChannelUsers('n1', '#test', 'JOIN', 'me');
			flushSync();
			buf = findBuf('n1', '#test')!;
			expect(buf.users.filter((u: { nick: string }) => stripPrefix(u.nick) === 'me')).toHaveLength(1);

			// Simulate 353 with `@me` — in-place promotion at ircStore.svelte.ts
			// ~line 1791 upgrades the bare entry to `@me` with prefix `@`.
			updateChannelUsers('n1', '#test', '353', 'sender', ['#test', '', '@me']);
			flushSync();
			buf = findBuf('n1', '#test')!;
			const meEntries = buf.users.filter((u: { nick: string }) => stripPrefix(u.nick) === 'me');
			expect(meEntries).toHaveLength(1);
			expect(meEntries[0].nick).toBe('@me');
			expect(meEntries[0].prefix).toBe('@');
		});

		// ── T8: sync with isJoined:false immediately after click does NOT clobber ──
		it('T8: sync snapshot with isJoined=false arriving within click→echo window does NOT clobber isJoined', () => {
			const net = createNetwork({ networkId: 'n1', currentNick: 'me' });
			const buf = createBuffer({ name: '#test', isJoined: true, isPhantom: false });
			net.buffers.push(buf);
			ircState.networks.push(net);

			// Click → sets the four flags; joinInFlight=true now.
			initiateRejoin('n1', '#test');
			flushSync();
			expect(findBuf('n1', '#test')!.joinInFlight).toBe(true);

			// Engine sync arrives with isJoined=false (snapshot taken BEFORE
			// the JOIN echo propagated). The sync guard at
			// ircStore.svelte.ts:1478 must skip adoption while joinInFlight=true.
			const syncNet = createNetwork({ networkId: 'n1' });
			syncNet.buffers.push(createBuffer({ name: '#test', isJoined: false }));
			syncNet.buffers.push(createBuffer({ name: '_server', type: 'server', isJoined: true }));
			updateNetworkFromSync([syncNet]);
			flushSync();

			const found = findBuf('n1', '#test')!;
			// pendingIsJoined=true contradicts sync's isJoined=false → "keep
			// event state" branch in updateNetworkFromSync runs (no decrement).
			expect(found.isJoined).toBe(true);
			// joinInFlight must persist until JOIN for self arrives; sync alone
			// doesn't clear it.
			expect(found.joinInFlight).toBe(true);
			// Counter is only decremented on the confirming-sync branch. A
			// contradicting sync leaves pendingConfirmations=2 (still requires
			// two consecutive confirming syncs to clear).
			expect(found.pendingConfirmations).toBe(2);
			expect(found.pendingIsJoined).toBe(true);
		});

		// ── T9: WS-resume buffersToDelete during in-flight JOIN is guarded ──
		it('T9: WS-resume + buffersToDelete guard survives across in-flight JOIN', () => {
			setupBuf({ isJoined: false });
			initiateRejoin('n1', '#test');
			flushSync();
			// act: simulate WS resume carrying a buffersToDelete for `n1:#test`
			handleBuffersToDelete(['n1:#test']);
			flushSync();

			// buffersToDelete guard at ircStore.svelte.ts:557 skipped the
			// deletion because activeJoinList still has the key from recordJoin.
			const net = ircState.networks.find((n) => n.networkId === 'n1')!;
			expect(net.buffers.some((b) => b.name === '#test')).toBe(true);
			expect(activeJoinList.has('n1:#test')).toBe(true);
		});

		// ── T10: WS-reconnect ordering known-issue (callout) ────────────────
		it('T10: reconnect ordering — resetPendingState clears pendingJoins but preserves activeJoinList guard', () => {
			setupBuf({ connected: false });
			initiateRejoin('n1', '#test', { allowReconnect: true });
			flushSync();

			// After click: pendingJoins is set, activeJoinList is set,
			// reconnectNetwork fired for the disconnected network.
			expect(isJoinPending('n1', '#test')).toBe(true);
			expect(activeJoinList.has('n1:#test')).toBe(true);
			expect(vi.mocked(reconnectNetwork)).toHaveBeenCalledWith('n1');

			// WS reconnects → App.svelte's onOpen calls resetPendingState
			// to clear stuck pendingJoins + joinInFlight.
			resetPendingState();

			// pendingJoins cleared; activeJoinList SURVIVES (the buffersToDelete
			// guard must persist across reconnect).
			expect(isJoinPending('n1', '#test')).toBe(false);
			expect(activeJoinList.has('n1:#test')).toBe(true);

			// Stale engine sync arrives (snapshot from BEFORE the JOIN echo)
			// — the guard at ircStore.svelte.ts:1378 doesn't protect here
			// because pendingIsJoined was cleared by resetPendingState. The
			// sync IS authoritative and flips isJoined back to false. This
			// is the known flicker window: subsequent JOIN echo restores
			// isJoined=true within one WS round-trip.
			const syncNet = createNetwork({ networkId: 'n1' });
			syncNet.buffers.push(createBuffer({ name: '#test', isJoined: false }));
			syncNet.buffers.push(createBuffer({ name: '_server', type: 'server', isJoined: true }));
			updateNetworkFromSync([syncNet]);
			flushSync();

			const found = findBuf('n1', '#test')!;
			// Known-issue callout — documented as acceptable flicker window.
			expect(found.isJoined).toBe(false);
			// But the buffer survives: activeJoinList guard holds against
			// any concurrent buffersToDelete.
			handleBuffersToDelete(['n1:#test']);
			flushSync();
			const net = ircState.networks.find((n) => n.networkId === 'n1')!;
			expect(net.buffers.some((b) => b.name === '#test')).toBe(true);
		});

		// ── T11: offline rejoin path (BufferHeader.expectsReconnect=true) ────
		it('T11: offline rejoin path — disconnected network + allowReconnect=true fires reconnectNetwork and JOIN', () => {
			const net = createNetwork({
				networkId: 'n1',
				name: 'net',
				connected: false,
				currentNick: 'me',
			});
			const buf = createBuffer({ name: '#test', isJoined: false, users: [] });
			net.buffers.push(buf);
			ircState.networks.push(net);

			initiateRejoin('n1', '#test', { allowReconnect: true });
			flushSync();

			// State-machine quartet is set on the buffer.
			expect(findBuf('n1', '#test')!.joinInFlight).toBe(true);
			expect(findBuf('n1', '#test')!.pendingIsJoined).toBe(true);
			expect(findBuf('n1', '#test')!.pendingConfirmations).toBe(2);
			// reconnectNetwork fired (mirrors BufferHeader's reconnect-then-JOIN).
			expect(vi.mocked(reconnectNetwork)).toHaveBeenCalledWith('n1');
			// JOIN queued via sendRaw.
			expect(vi.mocked(sendRaw)).toHaveBeenCalledWith('n1', 'JOIN #test');
		});
	});

	describe('self-nick in userlist', () => {
		it('adds own nick on JOIN for self (existing buffer)', () => {
			const net = createNetwork({ networkId: 'n1', currentNick: 'me' });
			net.buffers.push(createBuffer({ name: '#chan', users: [] }));
			ircState.networks.push(net);

			updateChannelUsers('n1', '#chan', 'JOIN', 'me');
			flushSync();

			const found = ircState.networks.find(n => n.networkId === 'n1')!
				.buffers.find(b => b.name === '#chan')!;
			expect(found.users.some(u => u.nick === 'me')).toBe(true);
			expect(found.users.find(u => u.nick === 'me')?.category).toBe('MEMBER');
		});

		it('adds own nick on JOIN for self (auto-created buffer)', () => {
			const net = createNetwork({ networkId: 'n1', currentNick: 'me' });
			ircState.networks.push(net);

			updateChannelUsers('n1', '#chan', 'JOIN', 'me');
			flushSync();

			const found = ircState.networks.find(n => n.networkId === 'n1')!
				.buffers.find(b => b.name === '#chan');
			expect(found).toBeDefined();
			expect(found!.users.some(u => u.nick === 'me')).toBe(true);
		});

		it('does not duplicate own nick when 353 arrives after JOIN', () => {
			const net = createNetwork({ networkId: 'n1', currentNick: 'me' });
			net.buffers.push(createBuffer({ name: '#duck', users: [] }));
			ircState.networks.push(net);

			// Self-JOIN adds "me"
			updateChannelUsers('n1', '#duck', 'JOIN', 'me');
			flushSync();

			// 353 arrives with "me" included — dedup must prevent duplicate
			updateChannelUsers('n1', '#duck', '353', '', ['#duck', '@alice +bob me charlie']);
			flushSync();

			const found = ircState.networks.find(n => n.networkId === 'n1')!
				.buffers.find(b => b.name === '#duck')!;
			// "me" appears exactly once
			const meEntries = found.users.filter(u => u.nick === 'me');
			expect(meEntries).toHaveLength(1);
			// All 4 unique nicks present (sorted ASCII: '+' < '@' < 'a')
			expect(found.users.map(u => u.nick).sort()).toEqual(['+bob', '@alice', 'charlie', 'me']);
		});

		it('re-adds own nick when sync overwrites users without it (W8-T01)', () => {
			// Regression for the "I'm not in the member list" bug: a sync
			// snapshot that omits self-nick (engine snapshot taken before
			// the user's own JOIN echoed through to channelUsers, or the
			// user joined from another client) used to permanently wipe
			// self from the roster. The sync handler now re-adds self-nick
			// whenever isJoined === true and the incoming users list
			// doesn't already include the bare self-nick.
			const net = createNetwork({ networkId: 'n1', currentNick: 'zod' });
			const buf = createBuffer({ name: '#zod', users: [{ nick: 'zod', prefix: '', category: 'MEMBER', ident: '', realname: '', isAway: false, awayMessage: '', lastSpoke: 0, lastHighlighted: 0, account: '' }] });
			net.buffers.push(buf);
			ircState.networks.push(net);

			// Sync overwrites users without "zod" (e.g. engine snapshot
			// from before the self-JOIN was added to channelUsers). The
			// sync payload MUST carry the same currentNick as the live
			// network — the sync handler adopts the engine's authoritative
			// nick when it differs (no currentNickUpdatedAt guard), and a
			// stale factory default would clobber 'zod' with 'tester' and
			// break the self-nick re-add below.
			const syncNet = createNetwork({ networkId: 'n1', currentNick: 'zod' });
			syncNet.buffers.push(createBuffer({ name: '#zod', users: [{ nick: '@alice', prefix: '@', category: 'OP', ident: '', realname: '', isAway: false, awayMessage: '', lastSpoke: 0, lastHighlighted: 0, account: '' }, { nick: 'charlie', prefix: '', category: 'MEMBER', ident: '', realname: '', isAway: false, awayMessage: '', lastSpoke: 0, lastHighlighted: 0, account: '' }] }));
			syncNet.buffers.push(createBuffer({ name: '_server', type: 'server', isJoined: true }));
			updateNetworkFromSync([syncNet]);
			flushSync();

			const found = ircState.networks.find(n => n.networkId === 'n1')!
				.buffers.find(b => b.name === '#zod')!;
			// Self-nick is re-added by the sync handler because the buffer
			// is genuinely joined (isJoined === true). Without this re-add,
			// the user would disappear from the member list and stay gone
			// until the next JOIN/PART cycle — see W8-T01 regression tests
			// at the end of this file for the full lifecycle.
			expect(found.users.map(u => u.nick).sort()).toEqual(['@alice', 'charlie', 'zod']);
		});

		it('self-nick is always exactly one entry in users after JOIN', () => {
			const net = createNetwork({ networkId: 'n1', currentNick: 'me' });
			net.buffers.push(createBuffer({ name: '#cycle' }));
			ircState.networks.push(net);

			// Use found (via reactive ircState) so we read the proxied object
			const found = () => ircState.networks.find(n => n.networkId === 'n1')!
				.buffers.find(b => b.name === '#cycle')!;

			// Join adds "me"
			updateChannelUsers('n1', '#cycle', 'JOIN', 'me');
			flushSync();
			expect(found().users.filter(u => u.nick === 'me')).toHaveLength(1);

			// Calling JOIN a second time (e.g. race with 353) must not duplicate
			updateChannelUsers('n1', '#cycle', 'JOIN', 'me');
			flushSync();
			expect(found().users.filter(u => u.nick === 'me')).toHaveLength(1);

			// PART doesn't remove self from users, but rejoin keeps it at 1
			updateChannelUsers('n1', '#cycle', 'PART', 'me');
			updateChannelUsers('n1', '#cycle', 'JOIN', 'me');
			flushSync();
			expect(found().users.filter(u => u.nick === 'me')).toHaveLength(1);
		});

		it('realtime nick change: updates member list, no stale nicks, no duplicates, across all channels', () => {
			// Uses ircState to read reactive values so Svelte $state proxies
			// are consulted, not the POJO returned by createNetwork.
			const net = createNetwork({ networkId: 'n1', currentNick: 'alice' });
			net.buffers.push(createBuffer({ name: '_server', type: 'server' }));
			const chanA = createBuffer({ name: '#foo', users: [
				{ nick: '@alice', prefix: '@', category: 'OP', ident: '', realname: '', isAway: false, awayMessage: '', lastSpoke: 0, lastHighlighted: 0, account: '' },
				{ nick: 'bob', prefix: '', category: 'MEMBER', ident: '', realname: '', isAway: false, awayMessage: '', lastSpoke: 0, lastHighlighted: 0, account: '' },
			] });
			const chanB = createBuffer({ name: '#bar', users: [
				{ nick: 'alice', prefix: '', category: 'MEMBER', ident: '', realname: '', isAway: false, awayMessage: '', lastSpoke: 0, lastHighlighted: 0, account: '' },
				{ nick: 'charlie', prefix: '', category: 'MEMBER', ident: '', realname: '', isAway: false, awayMessage: '', lastSpoke: 0, lastHighlighted: 0, account: '' },
			] });
			net.buffers.push(chanA, chanB);
			ircState.networks.push(net);

			const foundNet = () => ircState.networks.find(n => n.networkId === 'n1')!;

			// Step 1: simulate /nick command (optimistic update)
			foundNet().pendingSelfNickChange = { oldNick: 'alice', newNick: 'alice_new', setAt: Date.now() };
			foundNet().currentNick = 'alice_new';
			flushSync();
			expect(foundNet().currentNick).toBe('alice_new');

			// Step 2: you_nickchange event arrives (network-level handler)
			updateChannelUsers('n1', '#foo', 'you_nickchange', 'alice', ['alice', 'alice_new']);
			flushSync();

			expect(foundNet().currentNick).toBe('alice_new');
			expect(foundNet().pendingSelfNickChange).toBeUndefined();

			// Step 3: verify member list in EVERY channel
			const foundA = () => foundNet().buffers.find(b => b.name === '#foo')!;
			const foundB = () => foundNet().buffers.find(b => b.name === '#bar')!;

			const nickA = foundA().users.map(u => u.nick);
			const nickB = foundB().users.map(u => u.nick);

			// #foo: @alice → @alice_new (prefix preserved)
			expect(nickA).toContain('@alice_new');
			expect(nickA).not.toContain('@alice');
			expect(nickA).toContain('bob');
			expect(nickA.filter(n => n.includes('alice_new')).length).toBe(1);
			expect(new Set(nickA).size).toBe(nickA.length);

			// #bar: alice → alice_new
			expect(nickB).toContain('alice_new');
			expect(nickB).not.toContain('alice');
			expect(nickB).toContain('charlie');
			expect(nickB.filter(n => n.includes('alice_new')).length).toBe(1);
			expect(new Set(nickB).size).toBe(nickB.length);

			// Step 4: per-channel NICK events are redundant but harmless
			updateChannelUsers('n1', '#foo', 'NICK', 'alice', ['alice', 'alice_new']);
			updateChannelUsers('n1', '#foo', 'NICK', 'alice', ['alice', 'alice_new']);
			flushSync();

			const fooAfter = foundA().users.map(u => u.nick);
			expect(fooAfter.filter(n => n.includes('alice_new')).length).toBe(1);
			expect(new Set(fooAfter).size).toBe(fooAfter.length);
		});
	});

	describe('disconnect/reconnect guard', () => {
		beforeEach(() => {
			// Clear any residual disconnect state from other tests
			clearUserDisconnected('n1');
			clearUserDisconnected('n2');
		});

		it('markUserDisconnected / isUserDisconnected / clearUserDisconnected', () => {
			expect(isUserDisconnected('n1')).toBe(false);
			markUserDisconnected('n1');
			expect(isUserDisconnected('n1')).toBe(true);
			clearUserDisconnected('n1');
			expect(isUserDisconnected('n1')).toBe(false);
		});

		it('sync with connected=true does not overwrite after user disconnected', () => {
			const net = createNetwork({ networkId: 'n1' });
			net.connectionState = 'disconnected';
			net.connected = false;
			ircState.networks.push(net);

			// User clicked Disconnect
			markUserDisconnected('n1');

			// Stale sync reports connected=true (periodic snapshotter race)
			const incoming = createNetwork({ networkId: 'n1' });
			incoming.connected = true;
			incoming.status = 'connected';
			updateNetworkFromSync([incoming]);
			flushSync();

			const found = ircState.networks.find(n => n.networkId === 'n1')!;
			// Guard must prevent overwrite
			expect(found.connected).toBe(false);
			expect(found.connectionState).toBe('disconnected');
		});

		it('sync with connecting=true does NOT overwrite after user disconnected', () => {
			const net = createNetwork({ networkId: 'n1' });
			net.connectionState = 'disconnected';
			net.connected = false;
			ircState.networks.push(net);

			// User clicked Disconnect
			markUserDisconnected('n1');

			// Engine reports status=connecting (backoff or reconnect attempt)
			const incoming = createNetwork({ networkId: 'n1' });
			incoming.connected = false;
			incoming.status = 'connecting';
			updateNetworkFromSync([incoming]);
			flushSync();

			const found = ircState.networks.find(n => n.networkId === 'n1')!;
			// After explicit disconnect, 'connecting' IS suppressed — the user
			// has already said "disconnect me" and does not want to see
			// auto-reconnect attempts in the UI as "Connecting" phantom cards.
			expect(found.connectionState).toBe('disconnected');
		});

		it('clearUserDisconnected allows sync connected=true to update after reconnect', () => {
			const net = createNetwork({ networkId: 'n1' });
			net.connectionState = 'disconnected';
			net.connected = false;
			ircState.networks.push(net);

			markUserDisconnected('n1');

			// User clicks Reconnect
			clearUserDisconnected('n1');

			// Sync reports connected=true now that guard is cleared
			const incoming = createNetwork({ networkId: 'n1' });
			incoming.connected = true;
			incoming.status = 'connected';
			updateNetworkFromSync([incoming]);
			flushSync();

			const found = ircState.networks.find(n => n.networkId === 'n1')!;
			expect(found.connected).toBe(true);
			expect(found.connectionState).toBe('connected');
		});

		it('disconnecting one network does not affect another', () => {
			const n1 = createNetwork({ networkId: 'n1' });
			n1.connectionState = 'disconnected';
			n1.connected = false;
			const n2 = createNetwork({ networkId: 'n2' });
			n2.connectionState = 'connected';
			n2.connected = true;
			ircState.networks.push(n1, n2);

			markUserDisconnected('n1');

			// Sync for both networks arrives
			const sync1 = createNetwork({ networkId: 'n1' });
			sync1.connected = true;
			sync1.status = 'connected';
			const sync2 = createNetwork({ networkId: 'n2' });
			sync2.connected = true;
			sync2.status = 'connected';
			updateNetworkFromSync([sync1, sync2]);
			flushSync();

			const found1 = ircState.networks.find(n => n.networkId === 'n1')!;
			const found2 = ircState.networks.find(n => n.networkId === 'n2')!;
			// n1 disconnected — guard blocks connected=true
			expect(found1.connected).toBe(false);
			expect(found1.connectionState).toBe('disconnected');
			// n2 still connected — no guard
			expect(found2.connected).toBe(true);
			expect(found2.connectionState).toBe('connected');
		});

		it('double markUserDisconnected is idempotent', () => {
			markUserDisconnected('n1');
			markUserDisconnected('n1');  // second call
			expect(isUserDisconnected('n1')).toBe(true);
			clearUserDisconnected('n1');
			expect(isUserDisconnected('n1')).toBe(false);
		});

		it('reconnect without prior disconnect has no effect on guard', () => {
			// No disconnect was issued
			const net = createNetwork({ networkId: 'n1' });
			net.connectionState = 'connecting';
			net.connected = false;
			ircState.networks.push(net);

			// Sync reports connected=true
			const incoming = createNetwork({ networkId: 'n1' });
			incoming.connected = true;
			incoming.status = 'connected';
			updateNetworkFromSync([incoming]);
			flushSync();

			const found = ircState.networks.find(n => n.networkId === 'n1')!;
			// No guard — sync updates state
			expect(found.connected).toBe(true);
		});

		it('sync with disconnected status keeps state unchanged when user disconnected', () => {
			const net = createNetwork({ networkId: 'n1' });
			net.connectionState = 'disconnected';
			net.connected = false;
			ircState.networks.push(net);

			markUserDisconnected('n1');

			// Sync confirms disconnected — no conflict
			const incoming = createNetwork({ networkId: 'n1' });
			incoming.connected = false;
			incoming.status = 'disconnected';
			updateNetworkFromSync([incoming]);
			flushSync();

			const found = ircState.networks.find(n => n.networkId === 'n1')!;
			expect(found.connected).toBe(false);
			expect(found.connectionState).toBe('disconnected');
		});

		it('clearUserDisconnected allows sync connecting then connected transition', () => {
			const net = createNetwork({ networkId: 'n1' });
			net.connectionState = 'disconnected';
			net.connected = false;
			ircState.networks.push(net);

			markUserDisconnected('n1');
			clearUserDisconnected('n1');

			// Engine starts connecting
			const sync1 = createNetwork({ networkId: 'n1' });
			sync1.connected = false;
			sync1.status = 'connecting';
			updateNetworkFromSync([sync1]);
			flushSync();

			const found1 = ircState.networks.find(n => n.networkId === 'n1')!;
			expect(found1.connectionState).toBe('connecting');

			// Engine connects successfully
			const sync2 = createNetwork({ networkId: 'n1' });
			sync2.connected = true;
			sync2.status = 'connected';
			updateNetworkFromSync([sync2]);
			flushSync();

			const found2 = ircState.networks.find(n => n.networkId === 'n1')!;
			expect(found2.connected).toBe(true);
			expect(found2.connectionState).toBe('connected');
		});
	});

	describe('self-echo dedup', () => {
		const networkId = 'net1';
		const bufferName = '#echo';
		const key = `${networkId}:${bufferName}`;

		beforeEach(() => {
			const net = createNetwork({ networkId });
			net.buffers.push(createBuffer({ name: bufferName }));
			ircState.networks.push(net);
			ircState.messages[key] = [];
			ircState.processedMessages[key] = buildProcessedBuffer([]);
	ircState.optimisticMessages.clear();
});

		function setCurrentNick(nick: string): void {
			const net = ircState.networks.find(n => n.networkId === networkId)!;
			net.currentNick = nick;
		}

		it('batchAppendMessages replaces optimistic by label and rebuilds cache', () => {
			setCurrentNick('me');
			const label = 'label-1';
			const optimistic = createMessage({ label, nick: 'me', text: 'hello', command: 'PRIVMSG' });
			ircState.optimisticMessages.set(label, optimistic);
			ircState.messages[key] = [optimistic];
			ircState.processedMessages[key] = buildProcessedBuffer([optimistic]);

			// Echo arrives with matching label
			const echo = createMessage({ label, nick: 'me', text: 'hello', command: 'PRIVMSG', eid: 100 });
			batchAppendMessages(networkId, bufferName, [echo]);
			flushSync();

			// Raw array: only 1 message (optimistic replaced)
			expect(ircState.messages[key]).toHaveLength(1);
			expect(ircState.messages[key][0].eid).toBe(100);

			// Processed cache: 1 message (rebuilt)
			expect(ircState.processedMessages[key]).toHaveLength(1);
			expect(ircState.optimisticMessages.has(label)).toBe(false);
		});

		it('batchAppendMessages dedups self-echo by text with case-insensitive nick', () => {
			setCurrentNick('Zod');
			const label = 'label-2';
			const optimistic = createMessage({ label, nick: 'Zod', text: 'hi there', command: 'PRIVMSG' });
			ircState.optimisticMessages.set(label, optimistic);
			ircState.messages[key] = [optimistic];
			ircState.processedMessages[key] = buildProcessedBuffer([optimistic]);

			// Echo arrives with NO label (no labeled-response) but with selfEcho
			// and DIFFERENT nick casing ("zod" vs "Zod")
			const echo = createMessage({ nick: 'zod', text: 'hi there', command: 'PRIVMSG', eid: 200, selfEcho: true });
			batchAppendMessages(networkId, bufferName, [echo]);
			flushSync();

			// Raw array: 1 message (optimistic replaced by echo)
			expect(ircState.messages[key]).toHaveLength(1);
			expect(ircState.messages[key][0].eid).toBe(200);

			// Optimistic consumed
			expect(ircState.optimisticMessages.has(label)).toBe(false);
		});

		it('batchAppendMessages dedup prevents duplicate when label and selfEcho both present', () => {
			setCurrentNick('me');
			const label = 'label-3';
			const optimistic = createMessage({ label, nick: 'me', text: 'hello', command: 'PRIVMSG' });
			ircState.optimisticMessages.set(label, optimistic);
			ircState.messages[key] = [optimistic];
			ircState.processedMessages[key] = buildProcessedBuffer([optimistic]);

			// Echo has BOTH label AND selfEcho (common case)
			const echo = createMessage({ label, nick: 'me', text: 'hello', command: 'PRIVMSG', eid: 300, selfEcho: true });
			batchAppendMessages(networkId, bufferName, [echo]);
			flushSync();

			// Exactly one message (not two)
			expect(ircState.messages[key]).toHaveLength(1);
		});

		it('batchAppendMessages multiple echos in same batch dedup correctly', () => {
			setCurrentNick('me');
			const label1 = 'l1';
			const label2 = 'l2';
			const opt1 = createMessage({ label: label1, nick: 'me', text: 'first', command: 'PRIVMSG' });
			const opt2 = createMessage({ label: label2, nick: 'me', text: 'second', command: 'PRIVMSG' });
			ircState.optimisticMessages.set(label1, opt1);
			ircState.optimisticMessages.set(label2, opt2);
			ircState.messages[key] = [opt1, opt2];
			ircState.processedMessages[key] = buildProcessedBuffer([opt1, opt2]);

			// Both echos in same batch
			const echo1 = createMessage({ label: label1, nick: 'me', text: 'first', command: 'PRIVMSG', eid: 400 });
			const echo2 = createMessage({ label: label2, nick: 'me', text: 'second', command: 'PRIVMSG', eid: 401 });
			batchAppendMessages(networkId, bufferName, [echo1, echo2]);
			flushSync();

			expect(ircState.messages[key]).toHaveLength(2);
			expect(ircState.messages[key].every(m => m.eid != null)).toBe(true);
			expect(ircState.optimisticMessages.size).toBe(0);
		});

		it('appendMessage replaces optimistic by label and rebuilds cache', () => {
			setCurrentNick('me');
			const label = 'label-a';
			const optimistic = createMessage({ label, nick: 'me', text: 'direct', command: 'PRIVMSG' });
			ircState.optimisticMessages.set(label, optimistic);
			ircState.messages[key] = [optimistic];
			ircState.processedMessages[key] = buildProcessedBuffer([optimistic]);

			// Echo arrives via direct appendMessage
			const echo = createMessage({ label, nick: 'me', text: 'direct', command: 'PRIVMSG', eid: 500 });
			appendMessage(networkId, bufferName, echo);
			flushSync();

			expect(ircState.messages[key]).toHaveLength(1);
			expect(ircState.messages[key][0].eid).toBe(500);
			expect(ircState.optimisticMessages.has(label)).toBe(false);
		});

		it('appendMessage dedups self-echo with case-insensitive nick', () => {
			setCurrentNick('Alice');
			const label = 'label-b';
			const optimistic = createMessage({ label, nick: 'Alice', text: 'hey', command: 'PRIVMSG' });
			ircState.optimisticMessages.set(label, optimistic);
			ircState.messages[key] = [optimistic];
			ircState.processedMessages[key] = buildProcessedBuffer([optimistic]);

			// Self-echo with different casing
			const echo = createMessage({ nick: 'alice', text: 'hey', command: 'PRIVMSG', eid: 600, selfEcho: true });
			appendMessage(networkId, bufferName, echo);
			flushSync();

			expect(ircState.messages[key]).toHaveLength(1);
			expect(ircState.optimisticMessages.has(label)).toBe(false);
		});
	});
});

// ─────────────────────────────────────────────────────────────────────
// W2-T02 + W1-T01 B3: applyRetryStatus / applyFail + sync adopt.
// TG5 explicitly pins `applyRetryStatus(networkId, null)` to clear
// BOTH retryStatus AND failInfo — the on-store counterpart to the
// engine's zero-valued CONNECTION_RETRY_STATUS emitted from every
// `backoff.reset()` site.
// ─────────────────────────────────────────────────────────────────────

describe('applyRetryStatus (W2-T02 — engine CONNECTION_RETRY_STATUS adapter)', () => {
	function setupNetwork(networkId: string): Network {
		const net = createNetwork({ networkId });
		ircState.networks.push(net);
		return net;
	}
	// Read the live, proxied network. `net` (the local return value
	// of setupNetwork) is a pre-push reference that doesn't track the
	// proxied mutations Svelte 5 performs after ircState.networks.push;
	// all assertions read through ircState.networks.find so we observe
	// the post-mutation reactive state.
	const live = (id: string) => ircState.networks.find((n) => n.networkId === id)!;

	it('writes retryStatus onto the matching network', () => {
		setupNetwork('net1');
		const rs: RetryStatus = {
			attemptCount: 2,
			nextRetryAtMs: Date.now() + 5000,
			delayMs: 5000,
		};
		applyRetryStatus('net1', rs);
		flushSync();
		expect(live('net1').retryStatus).toEqual(rs);
	});

	it('null status clears retryStatus AND failInfo (TG5 critical invariant)', () => {
		// Simulates the post-fail recovery cycle: the engine emits
		// `{attemptCount:0, nextRetryAtMs:0, delayMs:0}` from every
		// `backoff.reset()` site. The frontend converts that to null
		// at the dispatch boundary; applyRetryStatus must clear BOTH
		// retryStatus AND failInfo so a stale "Disconnected: ..." line
		// doesn't survive a successful reconnect.
		const net = setupNetwork('net1');
		net.retryStatus = {
			attemptCount: 2,
			nextRetryAtMs: Date.now() + 5000,
			delayMs: 5000,
		};
		net.failInfo = {
			type: 'connecting_failed',
			reason: 'econnrefused',
			killedReason: '',
		} as FailInfo;

		// First confirm the precondition so a silent break doesn't make
		// the cleanup branch the only assertion.
		expect(live('net1').retryStatus).not.toBeNull();
		expect(live('net1').failInfo).not.toBeNull();

		applyRetryStatus('net1', null);
		flushSync();

		expect(live('net1').retryStatus).toBeNull();
		expect(live('net1').failInfo).toBeNull();
	});

	it('null status clears failInfo even when retryStatus was already null', () => {
		// Belt-and-suspenders: the same null-clear must drain failInfo
		// even if retryStatus was never set (e.g. snapshot arrived
		// without one). Without this a failInfo left over from an
		// earlier CONNECTION_FAIL event survives a successful connect.
		const net = setupNetwork('net1');
		net.failInfo = {
			type: 'killed',
			reason: '',
			killedReason: '(Ghost)',
		} as FailInfo;

		applyRetryStatus('net1', null);
		flushSync();

		expect(live('net1').failInfo).toBeNull();
	});

	it('is a no-op when the network is unknown', () => {
		// ircStore stays silent for unknown networkId on every other
		// apply function (applyIsupportUpdate, applyFail). Match that.
		expect(() => applyRetryStatus('not-a-network', {
			attemptCount: 1,
			nextRetryAtMs: Date.now(),
			delayMs: 1000,
		})).not.toThrow();
		// Same for null — must not throw on a missing network.
		expect(() => applyRetryStatus('not-a-network', null)).not.toThrow();
	});

	it('sync snapshot adopts retryStatus when present, nulls when absent (W2-T02 syncing path)', () => {
		// Update mechanism: the WS fresh-sync netObj carries retryStatus
		// only when the engine considers it active. Presence drives
		// apply/clear; absence forces a null — the engine CAN'T ship a
		// zero-valued retryStatus because `hasRetryStatus` gates that
		// at the protocol layer (protocol.d:518).
		setupNetwork('net1');
		const liveNet1 = () => live('net1');
		// Pre-existing retry survives if the new sync doesn't ship one.
		liveNet1().retryStatus = {
			attemptCount: 4,
			nextRetryAtMs: Date.now() + 30000,
			delayMs: 30000,
		};
		const incoming = createNetwork({
			networkId: 'net1',
		});
		// Note: incoming.retryStatus is undefined (default). The sync
		// path's "absent" branch then clears the local retryStatus.
		updateNetworkFromSync([incoming]);
		flushSync();
		// Sync omitted retryStatus — engine-omitted means healthy →
		// clear locally too. (This is the "fan-out" of TG5.)
		expect(liveNet1().retryStatus).toBeNull();

		// Now adopt a populated retryStatus from the sync. We populate
		// the incoming network then call updateNetworkFromSync; the
		// sync branch must adopt the populated value.
		const next = createNetwork({ networkId: 'net1' });
		next.retryStatus = {
			attemptCount: 7,
			nextRetryAtMs: Date.now() + 12000,
			delayMs: 12000,
		};
		updateNetworkFromSync([next]);
		flushSync();
		expect(liveNet1().retryStatus).toEqual(next.retryStatus);
	});
});

describe('applyFail (W2-T02 — engine CONNECTION_FAIL adapter)', () => {
	const live = (id: string) => ircState.networks.find((n) => n.networkId === id)!;

	it('writes failInfo onto the matching network', () => {
		const net = createNetwork({ networkId: 'net1' });
		ircState.networks.push(net);
		const fail: FailInfo = {
			type: 'connecting_failed',
			reason: 'nxdomain',
		};
		applyFail('net1', fail);
		flushSync();
		expect(live('net1').failInfo).toEqual(fail);
	});

	it('preserves a populated retryStatus (fail does not clear retry)', () => {
		// A CONNECTION_FAIL can land while the engine is mid-backoff
		// (the fail reason arrived; the retry schedule hasn't been
		// cleared yet). The clear-on-fail belongs to the engine's
		// NEXT backoff.reset() emit (which calls applyRetryStatus(null));
		// applyFail alone must NOT touch retryStatus.
		const net = createNetwork({ networkId: 'net1' });
		net.retryStatus = {
			attemptCount: 3,
			nextRetryAtMs: Date.now() + 8000,
			delayMs: 8000,
		};
		ircState.networks.push(net);
		applyFail('net1', {
			type: 'connecting_failed',
			reason: 'econnrefused',
		});
		flushSync();
		const liveNet = live('net1');
		expect(liveNet.retryStatus).toEqual({
			attemptCount: 3,
			nextRetryAtMs: expect.any(Number),
			delayMs: 8000,
		});
		expect(liveNet.failInfo).toEqual({
			type: 'connecting_failed',
			reason: 'econnrefused',
		});
	});

	it('preserves structured sslVerifyError (nested shape byte-for-byte)', () => {
		const net = createNetwork({ networkId: 'net1' });
		ircState.networks.push(net);
		const fail: FailInfo = {
			type: 'connecting_failed',
			reason: 'ssl_verify_error',
			sslVerifyError: { type: 'bad_cert', error: 'cert_expired' },
		};
		applyFail('net1', fail);
		flushSync();
		expect(live('net1').failInfo?.sslVerifyError).toEqual({
			type: 'bad_cert',
			error: 'cert_expired',
		});
	});

	it('is a no-op when the network is unknown', () => {
		expect(() => applyFail('not-a-network', {
			type: 'connecting_failed',
			reason: 'econnrefused',
		})).not.toThrow();
	});
});
