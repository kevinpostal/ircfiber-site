import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ircState, activeJoinList, pendingJoins } from '../stores/ircStore.svelte';
import { reconnectNetwork } from '../stores/api';
import { sendRaw } from '../stores/wsConnection.svelte';
import { createNetwork, createBuffer } from '../test/factories';
import { getSlashHandler } from './slashCommands';

// ── W3-T06: slash command mock wiring ─────────────────────────────────────
//
// slashCommands.ts (top-level) registers handlers via `registerSlash(...)`
// at module load. The `cycle / hop / rejoin` handlers delegate to
// initiateRejoin(networkId, chan, { allowReconnect: false }) inside
// ircStore.svelte.ts. To observe the side effects (sendRaw + the in-flight
// quartet + pendingJoins + activeJoinList), we mock sendRaw + reconnectNetwork
// from the modules ircStore.svelte.ts imports them from. Mirrors the
// pattern used by BufferHeader.test.ts and ChannelContextMenu.test.ts.
//
// Note: vi.mock factories are hoisted to the top of the file. We list
// every export referenced by ircStore.svelte.ts so the mock satisfies
// the module shape; vi.importActual inside a factory is forbidden when
// the factory references outer variables (vitest lift errors).

vi.mock('/src/stores/api', () => ({
	fetchMe: (() => undefined) as never,
	fetchHealth: (() => undefined) as never,
	loadHistory: (() => undefined) as never,
	loadHistoryWithMeta: (() => undefined) as never,
	reconnectNetwork: vi.fn(async () => undefined),
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
	normalizeMessage: vi.fn((m: unknown) => m),
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
}));

/**
 * Invoke a slash command the same way the InputArea.svelte handler does:
 * parse `text.slice(1).split(/\s+/)`, lowercase the cmd token, then call
 * getSlashHandler(cmd)(args, networkId, target, net) with the parsed args.
 *
 * Mirrors the production call site at InputArea.svelte:427-430 so the
 * test exercises the same path as a real user typing `/cycle #chan`.
 */
function dispatch(text: string, networkId: string, activeNetwork: unknown): void {
	const parts = text.slice(1).split(/\s+/);
	const cmd = parts[0].toLowerCase();
	const args = parts.slice(1);
	const handler = getSlashHandler(cmd);
	if (!handler) throw new Error(`No slash handler registered for /${cmd}`);
	// /cycle|hop|rejoin do not use the `target` arg — they require an
	// explicit channel arg in `args[0]`. Pass an empty target so the
	// handler falls back to args[0] per slashCommands.ts:202.
	handler(args, networkId, '', activeNetwork as never);
}

describe('/cycle /hop /rejoin slash commands (W3-T06)', () => {
	beforeEach(() => {
		ircState.networks.length = 0;
		activeJoinList.clear();
		pendingJoins.clear();
		vi.mocked(sendRaw).mockClear();
		vi.mocked(reconnectNetwork).mockClear();
	});

	it('/cycle #chan sets joinInFlight + pendingJoins + sends JOIN exactly once (no PART)', () => {
		const net = createNetwork({ networkId: 'n1', name: 'net', connected: true, currentNick: 'me' });
		net.buffers.push(createBuffer({ name: '#chan' }));
		ircState.networks.push(net);

		dispatch('/cycle #chan', 'n1', net);

		const buf = net.buffers.find((b) => b.name === '#chan')!;
		// State-machine quartet set on the buffer (proxy re-read).
		expect(buf.joinInFlight).toBe(true);
		expect(buf.pendingIsJoined).toBe(true);
		expect(buf.pendingConfirmations).toBe(2);
		expect(buf.joinError).toBe(null);
		// Dedup keys are populated (markJoinPending + recordJoin).
		expect(pendingJoins.has('n1:#chan')).toBe(true);
		expect(activeJoinList.has('n1:#chan')).toBe(true);
		// JOIN was sent exactly once.
		expect(vi.mocked(sendRaw)).toHaveBeenCalledTimes(1);
		expect(vi.mocked(sendRaw)).toHaveBeenCalledWith('n1', 'JOIN #chan');
		// The IRCCloud-semantics invariant: NO PART was sent (the W1-T01
		// refactor dropped the PART-before-JOIN behavior to avoid clobbering
		// `isJoined` mid-flow).
		expect(vi.mocked(sendRaw)).not.toHaveBeenCalledWith(
			'n1',
			expect.stringContaining('PART'),
		);
		// allowReconnect=false on /cycle: reconnectNetwork must NOT have fired.
		expect(vi.mocked(reconnectNetwork)).not.toHaveBeenCalled();
	});

	it('/hop #chan delegates identically to /cycle', () => {
		const net = createNetwork({ networkId: 'n1', name: 'net', connected: true, currentNick: 'me' });
		net.buffers.push(createBuffer({ name: '#hopchan' }));
		ircState.networks.push(net);

		dispatch('/hop #hopchan', 'n1', net);

		const buf = net.buffers.find((b) => b.name === '#hopchan')!;
		expect(buf.joinInFlight).toBe(true);
		expect(buf.pendingIsJoined).toBe(true);
		expect(buf.pendingConfirmations).toBe(2);
		expect(pendingJoins.has('n1:#hopchan')).toBe(true);
		expect(activeJoinList.has('n1:#hopchan')).toBe(true);
		expect(vi.mocked(sendRaw)).toHaveBeenCalledTimes(1);
		expect(vi.mocked(sendRaw)).toHaveBeenCalledWith('n1', 'JOIN #hopchan');
		expect(vi.mocked(sendRaw)).not.toHaveBeenCalledWith(
			'n1',
			expect.stringContaining('PART'),
		);
		expect(vi.mocked(reconnectNetwork)).not.toHaveBeenCalled();
	});

	it('/rejoin #chan delegates identically to /cycle', () => {
		const net = createNetwork({ networkId: 'n1', name: 'net', connected: true, currentNick: 'me' });
		net.buffers.push(createBuffer({ name: '#rejoinchan' }));
		ircState.networks.push(net);

		dispatch('/rejoin #rejoinchan', 'n1', net);

		const buf = net.buffers.find((b) => b.name === '#rejoinchan')!;
		expect(buf.joinInFlight).toBe(true);
		expect(buf.pendingIsJoined).toBe(true);
		expect(buf.pendingConfirmations).toBe(2);
		expect(pendingJoins.has('n1:#rejoinchan')).toBe(true);
		expect(activeJoinList.has('n1:#rejoinchan')).toBe(true);
		expect(vi.mocked(sendRaw)).toHaveBeenCalledTimes(1);
		expect(vi.mocked(sendRaw)).toHaveBeenCalledWith('n1', 'JOIN #rejoinchan');
		expect(vi.mocked(sendRaw)).not.toHaveBeenCalledWith(
			'n1',
			expect.stringContaining('PART'),
		);
		expect(vi.mocked(reconnectNetwork)).not.toHaveBeenCalled();
	});
});
