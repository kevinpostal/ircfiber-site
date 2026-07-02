// Regression test for the operator-status bug.
//
// When a service (e.g. ChanServ/Anope) auto-ops a user on JOIN, the server
// sends:
//   :ChanServ!services@host MODE #chan +o mynick
//
// The frontend's `updateChannelUsers` MODE branch has a bug: it treats
// `params[0]` as the mode string, but the IRC wire format puts the
// CHANNEL in params[0] and the mode string in params[1].
//
// This test reproduces the bug and asserts the fix. Run with:
//   npx vitest run --project=client src/stores/ircStore.svelte.test.ts -t "MODE with services auto-op"
import { describe, expect, it, beforeEach } from 'vitest';
import { flushSync } from 'svelte';
import { untrack } from 'svelte';
import {
	ircState,
	updateChannelUsers,
} from './ircStore.svelte';
import { createNetwork, createBuffer, createMember } from '../test/factories';

beforeEach(() => {
	ircState.networks.length = 0;
	ircState.activeBuffer.networkId = null;
	ircState.activeBuffer.bufferName = null;
	ircState.messages = {};
});

describe('updateChannelUsers MODE branch — services auto-op regression', () => {
	it('handles real IRC wire format: params = ["#chan", "+o", "mynick"]', () => {
		const net = createNetwork({ networkId: 'net1', currentNick: 'mynick' });
		const buf = createBuffer({
			name: '#chan',
			users: [createMember({ nick: 'mynick', prefix: '', category: 'MEMBER' })],
		});
		net.buffers.push(buf);
		ircState.networks.push(net);

		// Real wire format: MODE <channel> <modes> <target>...
		updateChannelUsers('net1', '#chan', 'MODE', 'ChanServ', ['#chan', '+o', 'mynick']);
		flushSync();

		const found = ircState.networks
			.find((n) => n.networkId === 'net1')!
			.buffers.find((b) => b.name === '#chan')!
			.users.find((u) => u.nick.replace(/^[@~&%+]/, '') === 'mynick')!;

		expect(found.prefix).toBe('@');
		expect(found.category).toBe('OP');
		expect(found.nick).toBe('@mynick');
	});

	it('handles de-op: params = ["#chan", "-o", "mynick"]', () => {
		const net = createNetwork({ networkId: 'net1', currentNick: 'mynick' });
		const buf = createBuffer({
			name: '#chan',
			users: [createMember({ nick: '@mynick', prefix: '@', category: 'OP' })],
		});
		net.buffers.push(buf);
		ircState.networks.push(net);

		updateChannelUsers('net1', '#chan', 'MODE', 'ChanServ', ['#chan', '-o', 'mynick']);
		flushSync();

		const found = ircState.networks
			.find((n) => n.networkId === 'net1')!
			.buffers.find((b) => b.name === '#chan')!
			.users.find((u) => u.nick.replace(/^[@~&%+]/, '') === 'mynick')!;

		expect(found.prefix).toBe('');
		expect(found.category).toBe('MEMBER');
		expect(found.nick).toBe('mynick');
	});

	it('handles user mode (self) — params = ["mynick", "+i"] (no targets)', () => {
		// User mode does not have a target; params[0] is the nick and the
		// mode string is params[1]. The branch should be a no-op for
		// channel user-list purposes, not crash.
		const net = createNetwork({ networkId: 'net1', currentNick: 'mynick' });
		const buf = createBuffer({
			name: '#chan',
			users: [createMember({ nick: 'mynick' })],
		});
		net.buffers.push(buf);
		ircState.networks.push(net);

		expect(() => {
			updateChannelUsers('net1', '#chan', 'MODE', 'mynick', ['mynick', '+i']);
			flushSync();
		}).not.toThrow();

		const users = untrack(() => ircState.networks
			.find((n) => n.networkId === 'net1')!
			.buffers.find((b) => b.name === '#chan')!
			.users);
		const found = users.find((u) => u.nick.replace(/^[@~&%+]/, '') === 'mynick')!;
		// User mode shouldn't change channel prefix
		expect(found.prefix).toBe('');
		expect(found.category).toBe('MEMBER');
	});

	it('handles multiple targets in one MODE: params = ["#chan", "+oo", "alice", "bob"]', () => {
		const net = createNetwork({ networkId: 'net1' });
		const buf = createBuffer({
			name: '#chan',
			users: [
				createMember({ nick: 'alice' }),
				createMember({ nick: 'bob' }),
			],
		});
		net.buffers.push(buf);
		ircState.networks.push(net);

		updateChannelUsers('net1', '#chan', 'MODE', 'ChanServ', ['#chan', '+oo', 'alice', 'bob']);
		flushSync();

		const found = ircState.networks.find((n) => n.networkId === 'net1');
		const users = found!.buffers.find((b) => b.name === '#chan')!.users;
		const alice = users.find((u) => u.nick.replace(/^[@~&%+]/, '') === 'alice')!;
		const bob = users.find((u) => u.nick.replace(/^[@~&%+]/, '') === 'bob')!;

		expect(alice.prefix).toBe('@');
		expect(alice.category).toBe('OP');
		expect(bob.prefix).toBe('@');
		expect(bob.category).toBe('OP');
	});
});
