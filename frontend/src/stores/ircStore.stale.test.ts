import { describe, it, expect, beforeEach } from 'vitest';
import { isNetworkStale, markNetworkSeen, DEFAULT_STALE_THRESHOLD_MS } from './ircStore.svelte';
import { ircState } from './ircStore.svelte';
import { createNetwork } from '../test/factories';

beforeEach(() => {
	ircState.networks.length = 0;
});

describe('isNetworkStale', () => {
	it('returns false for fresh networks', () => {
		expect(isNetworkStale({ lastSeenAt: Date.now() })).toBe(false);
	});

	it('returns true for old networks', () => {
		const tenMinAgo = Date.now() - 10 * 60 * 1000;
		expect(isNetworkStale({ lastSeenAt: tenMinAgo })).toBe(true);
	});

	it('respects custom threshold', () => {
		const thirtySecAgo = Date.now() - 30_000;
		expect(isNetworkStale({ lastSeenAt: thirtySecAgo }, 60_000)).toBe(false);
		expect(isNetworkStale({ lastSeenAt: thirtySecAgo }, 10_000)).toBe(true);
	});

	it('returns false when lastSeenAt is missing', () => {
		expect(isNetworkStale({})).toBe(false);
		expect(isNetworkStale({ lastSeenAt: null })).toBe(false);
		expect(isNetworkStale({ lastSeenAt: undefined })).toBe(false);
	});

	it('defaults to a 5-minute threshold', () => {
		expect(DEFAULT_STALE_THRESHOLD_MS).toBe(5 * 60 * 1000);
		const justUnder = Date.now() - (4 * 60 * 1000 + 59 * 1000);
		expect(isNetworkStale({ lastSeenAt: justUnder })).toBe(false);
		const justOver = Date.now() - (5 * 60 * 1000 + 1 * 1000);
		expect(isNetworkStale({ lastSeenAt: justOver })).toBe(true);
	});
});

describe('markNetworkSeen', () => {
	it('updates lastSeenAt on the matching network', () => {
		const net = createNetwork({ networkId: 'net-1', lastSeenAt: 0 });
		ircState.networks.push(net);

		const before = Date.now();
		markNetworkSeen('net-1');
		const after = Date.now();

		// Read back via the store so we get the reactive proxy, not the
		// pre-push reference (Svelte 5 wraps pushed objects in a proxy).
		const stored = ircState.networks.find(n => n.networkId === 'net-1');
		expect(stored?.lastSeenAt).toBeGreaterThanOrEqual(before);
		expect(stored?.lastSeenAt).toBeLessThanOrEqual(after);
	});

	it('is a no-op when the networkId is not found', () => {
		const net = createNetwork({ networkId: 'net-1', lastSeenAt: 1234 });
		ircState.networks.push(net);

		markNetworkSeen('does-not-exist');

		const stored = ircState.networks.find(n => n.networkId === 'net-1');
		expect(stored?.lastSeenAt).toBe(1234);
	});

	it('is a no-op when networkId is an empty string', () => {
		const net = createNetwork({ networkId: 'net-1', lastSeenAt: 1234 });
		ircState.networks.push(net);

		markNetworkSeen('');

		const stored = ircState.networks.find(n => n.networkId === 'net-1');
		expect(stored?.lastSeenAt).toBe(1234);
	});

	it('clears the stale state for a previously stale network', () => {
		const net = createNetwork({ networkId: 'net-1', lastSeenAt: Date.now() - 10 * 60 * 1000 });
		ircState.networks.push(net);

		const before = ircState.networks.find(n => n.networkId === 'net-1');
		expect(before).toBeDefined();
		expect(isNetworkStale(before!)).toBe(true);

		markNetworkSeen('net-1');

		const after = ircState.networks.find(n => n.networkId === 'net-1');
		expect(after).toBeDefined();
		expect(isNetworkStale(after!)).toBe(false);
	});
});