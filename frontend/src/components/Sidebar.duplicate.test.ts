import { describe, expect, it, beforeEach } from 'vitest';
import { render } from 'vitest-browser-svelte';
import Sidebar from './Sidebar.svelte';
import { createNetwork, createBuffer } from '../test/factories';
import { ircState } from '../stores/ircStore.svelte';
import type { Buffer } from '../types';

function resetState(): void {
	ircState.networks.length = 0;
	ircState.activeBuffer.networkId = null;
	ircState.activeBuffer.bufferName = null;
}

beforeEach(() => {
	resetState();
});

describe('Sidebar duplicate key guard', () => {
	it('renders without each_key_duplicate when networks have duplicate ids', () => {
		const net1 = createNetwork({ networkId: 'net1', name: 'Libera' });
		const net2 = createNetwork({ networkId: 'net1', name: 'Libera2' });
		ircState.networks.push(net1, net2);

		expect(() => {
			render(Sidebar, { props: { onSwitchBuffer: () => {}, onAddNetwork: () => {} } });
		}).not.toThrow();
	});

	it('renders without each_key_duplicate when buffers have duplicate names in one network', () => {
		const net = createNetwork({ networkId: 'net1', name: 'Libera' });
		const dup: Buffer = { name: '#general', type: 'channel', isJoined: true, unseen: false, unseenCount: 0, unseenHighlights: [], isPinned: false, isArchived: false, topic: '', topicSetBy: '', topicSetAt: 0, users: [], lastSeenMsgTime: null, firstUnseenMsgIndex: null };
		net.buffers.push(createBuffer({ name: '#general' }));
		net.buffers.push({ ...dup });
		ircState.networks.push(net);

		expect(() => {
			render(Sidebar, { props: { onSwitchBuffer: () => {}, onAddNetwork: () => {} } });
		}).not.toThrow();
	});
});
