import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page, userEvent } from 'vitest/browser';
import { flushSync } from 'svelte';
import BufferHeader from './BufferHeader.svelte';
import { createNetwork, createBuffer, createMember, createMessage } from '../test/factories';
import { ircState, clearTempUnavailable } from '../stores/ircStore.svelte';

vi.mock('/src/stores/api', () => ({
    fetchMe: vi.fn(async () => ({ username: 'tester', email: 'tester@test.local' })),
    fetchHealth: vi.fn(async () => ({ status: 'healthy', services: {} })),
    loadHistory: vi.fn(async () => []),
    reconnectNetwork: vi.fn(async () => undefined),
  clearBacklog: vi.fn(async () => undefined),
    disconnectNetwork: vi.fn(async () => undefined),
    joinChannel: vi.fn(async () => undefined),
    addNetwork: vi.fn(async () => undefined),
    updateNetwork: vi.fn(async () => undefined),
    deleteNetwork: vi.fn(async () => undefined),
    archiveChannel: vi.fn(async () => undefined),
    unarchiveChannel: vi.fn(async () => undefined),
    // ircStore imports this for the WebSocket-sync message normalization
    // path. The tests in this file don't exercise that path, so a
    // pass-through stub is fine.
    normalizeMessage: vi.fn((m: unknown) => m),
}));

vi.mock('/src/stores/wsConnection.svelte.ts', () => ({
    sendRaw: vi.fn(),
    sendMessage: vi.fn(),
    requestSync: vi.fn(),
    requestSwitchBuffer: vi.fn(),
    connectWebSocket: vi.fn(),
    disconnectWebSocket: vi.fn(),
    wsState: { value: 'disconnected' },
    maxEidTracker: { value: 0 },
    setMaxEid: vi.fn(),
}));

import { reconnectNetwork, disconnectNetwork } from '../stores/api';
import { sendRaw } from '../stores/wsConnection.svelte.ts';

function resetState(): void {
    ircState.networks.length = 0;
    ircState.activeBuffer.networkId = null;
    ircState.activeBuffer.bufferName = null;
    for (const k of Object.keys(ircState.messages)) delete ircState.messages[k];
}

beforeEach(() => {
	resetState();
});

describe('BufferHeader', () => {
	it('renders channel name', async () => {
		const net = createNetwork({ networkId: 'net1' });
		net.buffers.push(createBuffer({ name: '#general' }));
		ircState.networks.push(net);
		ircState.activeBuffer.networkId = 'net1';
		ircState.activeBuffer.bufferName = '#general';
		flushSync();

		render(BufferHeader, {
			props: { onAddNetwork: vi.fn(), onEditNetwork: vi.fn(), onJoinChannel: vi.fn(), onToggleMembers: vi.fn() },
		});

		await expect.element(page.getByText('#general')).toBeInTheDocument();
	});

	it('renders member count for channels', async () => {
		const net = createNetwork({ networkId: 'net1' });
		net.buffers.push(
			createBuffer({ name: '#general', users: [createMember({ nick: 'alice' }), createMember({ nick: 'bob' })] }),
		);
		ircState.networks.push(net);
		ircState.activeBuffer.networkId = 'net1';
		ircState.activeBuffer.bufferName = '#general';
		flushSync();

		render(BufferHeader, {
			props: { onAddNetwork: vi.fn(), onEditNetwork: vi.fn(), onJoinChannel: vi.fn(), onToggleMembers: vi.fn() },
		});

		expect(document.querySelector('#member-count')).toHaveTextContent('2');
	});

	it('renders topic when available', async () => {
		const net = createNetwork({ networkId: 'net1' });
		net.buffers.push(createBuffer({ name: '#general', topic: 'Welcome to #general' }));
		ircState.networks.push(net);
		ircState.activeBuffer.networkId = 'net1';
		ircState.activeBuffer.bufferName = '#general';
		flushSync();

		render(BufferHeader, {
			props: { onAddNetwork: vi.fn(), onEditNetwork: vi.fn(), onJoinChannel: vi.fn(), onToggleMembers: vi.fn() },
		});

		await expect.element(page.getByText('Welcome to #general')).toBeInTheDocument();
	});

	it('does not show edit/connect/disconnect for channels (IRCCloud style)', async () => {
		const net = createNetwork({ networkId: 'net1', connected: true });
		net.buffers.push(createBuffer({ name: '#general' }));
		ircState.networks.push(net);
		ircState.activeBuffer.networkId = 'net1';
		ircState.activeBuffer.bufferName = '#general';
		flushSync();

		render(BufferHeader, {
			props: { onAddNetwork: vi.fn(), onEditNetwork: vi.fn(), onJoinChannel: vi.fn(), onToggleMembers: vi.fn() },
		});

		// IRCCloud: channels only show member count + options gear
		expect(page.getByRole('button', { name: /edit/i })).not.toBeInTheDocument();
		expect(page.getByRole('button', { name: /disconnect/i })).not.toBeInTheDocument();
		expect(document.querySelector('#member-count')).toBeInTheDocument();
		expect(document.querySelector('.bufferOptions')).toBeInTheDocument();
	});

	it('shows edit/connect/disconnect for server buffer', async () => {
		const net = createNetwork({ networkId: 'net1', connected: true });
		net.buffers.push(createBuffer({ name: '_server', type: 'server' }));
		ircState.networks.push(net);
		ircState.activeBuffer.networkId = 'net1';
		ircState.activeBuffer.bufferName = '_server';
		flushSync();

		render(BufferHeader, {
			props: { onAddNetwork: vi.fn(), onEditNetwork: vi.fn(), onJoinChannel: vi.fn(), onToggleMembers: vi.fn() },
		});

		await expect.element(page.getByRole('button', { name: /edit/i })).toBeInTheDocument();
		await expect.element(page.getByRole('button', { name: /disconnect/i })).toBeInTheDocument();
	});

	it('shows connect button for server buffer when disconnected', async () => {
		const net = createNetwork({ networkId: 'net1', connected: false });
		ircState.networks.push(net);
		ircState.activeBuffer.networkId = 'net1';
		ircState.activeBuffer.bufferName = '_server';
		flushSync();

		render(BufferHeader, {
			props: { onAddNetwork: vi.fn(), onEditNetwork: vi.fn(), onJoinChannel: vi.fn(), onToggleMembers: vi.fn() },
		});

		await expect.element(page.getByRole('button', { name: /connect/i })).toBeInTheDocument();
	});

	it('calls onToggleMembers', async () => {
		const onToggleMembers = vi.fn();
		const net = createNetwork({ networkId: 'net1' });
		net.buffers.push(createBuffer({ name: '#general' }));
		ircState.networks.push(net);
		ircState.activeBuffer.networkId = 'net1';
		ircState.activeBuffer.bufferName = '#general';
		flushSync();

		render(BufferHeader, {
			props: { onAddNetwork: vi.fn(), onEditNetwork: vi.fn(), onJoinChannel: vi.fn(), onToggleMembers, memberPanelOpen: true },
		});

		const btn = page.getByRole('button', { name: /members list/i });
		await expect.element(btn).toBeInTheDocument();
		await userEvent.click(btn);
		expect(onToggleMembers).toHaveBeenCalled();
	});

	it('switches to server buffer when Connect is clicked on server buffer', async () => {
		const net = createNetwork({ networkId: 'net1', connected: false, connectionState: 'disconnected' });
		net.buffers.push(createBuffer({ name: '_server', type: 'server' }));
		ircState.networks.push(net);
		ircState.activeBuffer.networkId = 'net1';
		ircState.activeBuffer.bufferName = '_server';
		flushSync();

		render(BufferHeader, {
			props: { onAddNetwork: vi.fn(), onEditNetwork: vi.fn(), onJoinChannel: vi.fn(), onToggleMembers: vi.fn() },
		});

		const connectBtn = page.getByRole('button', { name: /connect/i });
		await expect.element(connectBtn).toBeInTheDocument();
		await userEvent.click(connectBtn);

		// Verify the active buffer switched to _server
		expect(ircState.activeBuffer.networkId).toBe('net1');
		expect(ircState.activeBuffer.bufferName).toBe('_server');

		// Verify connection state changed to connecting (not waiting for server)
		const updatedNet = ircState.networks.find(n => n.networkId === 'net1');
		expect(updatedNet?.connectionState).toBe('connecting');
		// connected stays false until the engine sends 001 (RPL_WELCOME)
		expect(updatedNet?.connected).toBe(false);

		// Verify the reconnect API was called
		expect(reconnectNetwork).toHaveBeenCalledWith('net1');
	});

	it('shows Disconnect button when connectionState is connecting', async () => {
		const net = createNetwork({ networkId: 'net1', connected: false, connectionState: 'connecting' });
		net.buffers.push(createBuffer({ name: '_server', type: 'server' }));
		ircState.networks.push(net);
		ircState.activeBuffer.networkId = 'net1';
		ircState.activeBuffer.bufferName = '_server';
		flushSync();

		render(BufferHeader, {
			props: { onAddNetwork: vi.fn(), onEditNetwork: vi.fn(), onJoinChannel: vi.fn(), onToggleMembers: vi.fn() },
		});

		const btn = page.getByRole('button', { name: /disconnect/i });
		await expect.element(btn).toBeInTheDocument();
	});

	it('calls disconnectNetwork when Disconnect is clicked while connecting', async () => {
		const net = createNetwork({ networkId: 'net1', connected: false, connectionState: 'connecting' });
		net.buffers.push(createBuffer({ name: '_server', type: 'server' }));
		ircState.networks.push(net);
		ircState.activeBuffer.networkId = 'net1';
		ircState.activeBuffer.bufferName = '_server';
		flushSync();

		render(BufferHeader, {
			props: { onAddNetwork: vi.fn(), onEditNetwork: vi.fn(), onJoinChannel: vi.fn(), onToggleMembers: vi.fn() },
		});

		const btn = page.getByRole('button', { name: /disconnect/i });
		await expect.element(btn).toBeInTheDocument();
		await userEvent.click(btn);

		expect(disconnectNetwork).toHaveBeenCalledWith('net1');

		const updatedNet = ircState.networks.find(n => n.networkId === 'net1');
		expect(updatedNet?.connectionState).toBe('disconnected');
		expect(updatedNet?.connected).toBe(false);
	});

	it('calls disconnectNetwork when Disconnect is clicked while fully connected', async () => {
		const net = createNetwork({ networkId: 'net1', connected: true, connectionState: 'connected' });
		net.buffers.push(createBuffer({ name: '_server', type: 'server' }));
		ircState.networks.push(net);
		ircState.activeBuffer.networkId = 'net1';
		ircState.activeBuffer.bufferName = '_server';
		flushSync();

		render(BufferHeader, {
			props: { onAddNetwork: vi.fn(), onEditNetwork: vi.fn(), onJoinChannel: vi.fn(), onToggleMembers: vi.fn() },
		});

		const btn = page.getByRole('button', { name: /disconnect/i });
		await expect.element(btn).toBeInTheDocument();
		await userEvent.click(btn);

		expect(disconnectNetwork).toHaveBeenCalledWith('net1');
	});

	it('does not show Disconnect button when disconnected', async () => {
		const net = createNetwork({ networkId: 'net1', connected: false, connectionState: 'disconnected' });
		net.buffers.push(createBuffer({ name: '_server', type: 'server' }));
		ircState.networks.push(net);
		ircState.activeBuffer.networkId = 'net1';
		ircState.activeBuffer.bufferName = '_server';
		flushSync();

		render(BufferHeader, {
			props: { onAddNetwork: vi.fn(), onEditNetwork: vi.fn(), onJoinChannel: vi.fn(), onToggleMembers: vi.fn() },
		});

		await expect(page.getByRole('button', { name: /disconnect/i })).not.toBeInTheDocument();
	});

	it('shows Rejoin button on a channel buffer that is not joined', async () => {
		const net = createNetwork({ networkId: 'net1' });
		net.buffers.push(createBuffer({ name: '#ircfiber', isJoined: false }));
		ircState.networks.push(net);
		ircState.activeBuffer.networkId = 'net1';
		ircState.activeBuffer.bufferName = '#ircfiber';
		flushSync();

		render(BufferHeader, {
			props: { onAddNetwork: vi.fn(), onEditNetwork: vi.fn(), onJoinChannel: vi.fn(), onToggleMembers: vi.fn() },
		});

		const rejoinBtn = page.getByRole('button', { name: /^rejoin$/i });
		await expect.element(rejoinBtn).toBeInTheDocument();
	});

	it('clicking Rejoin sends a JOIN for the active channel buffer (e2e)', async () => {
		vi.mocked(sendRaw).mockClear();
		const net = createNetwork({ networkId: 'net1' });
		net.buffers.push(createBuffer({ name: '#ircfiber', isJoined: false }));
		ircState.networks.push(net);
		ircState.activeBuffer.networkId = 'net1';
		ircState.activeBuffer.bufferName = '#ircfiber';
		flushSync();

		render(BufferHeader, {
			props: { onAddNetwork: vi.fn(), onEditNetwork: vi.fn(), onJoinChannel: vi.fn(), onToggleMembers: vi.fn() },
		});

		const rejoinBtn = page.getByRole('button', { name: /^rejoin$/i });
		await expect.element(rejoinBtn).toBeInTheDocument();
		await userEvent.click(rejoinBtn);

		expect(sendRaw).toHaveBeenCalledWith('net1', 'JOIN #ircfiber');

		// W3-T05: assert the in-flight quartet is set on the active buffer.
		const foundBuf = ircState.networks.find(n => n.networkId === 'net1')!
			.buffers.find(b => b.name === '#ircfiber')!;
		expect(foundBuf.joinInFlight).toBe(true);
		expect(foundBuf.pendingIsJoined).toBe(true);
		expect(foundBuf.pendingConfirmations).toBe(2);
		expect(foundBuf.joinError).toBe(null);
	});

	it('BufferHeader joining-chip is visible while joinInFlight=true', async () => {
		const net = createNetwork({ networkId: 'net1' });
		const buf = createBuffer({ name: '#testchannel' });
		// Drive joinInFlight at the buffer level (simulates initiateRejoin click)
		buf.joinInFlight = true;
		net.buffers.push(buf);
		ircState.networks.push(net);
		ircState.activeBuffer.networkId = 'net1';
		ircState.activeBuffer.bufferName = '#testchannel';
		flushSync();

		render(BufferHeader, {
			props: { onAddNetwork: vi.fn(), onEditNetwork: vi.fn(), onJoinChannel: vi.fn(), onToggleMembers: vi.fn() },
		});

		// BufferHeader.svelte renders `Joining {channelName}…` (line 164) when
		// activeBufferObj.joinInFlight is true. The chip is a .join-inflight-chip
		// and the text uses the ellipsis character "…" (U+2026).
		await expect.element(page.getByText(/Joining #testchannel…/i)).toBeInTheDocument();
	});

	it('does not show Rejoin button on a joined channel', async () => {
		const net = createNetwork({ networkId: 'net1' });
		net.buffers.push(createBuffer({ name: '#general', isJoined: true }));
		ircState.networks.push(net);
		ircState.activeBuffer.networkId = 'net1';
		ircState.activeBuffer.bufferName = '#general';
		flushSync();

		render(BufferHeader, {
			props: { onAddNetwork: vi.fn(), onEditNetwork: vi.fn(), onJoinChannel: vi.fn(), onToggleMembers: vi.fn() },
		});

		await expect(page.getByRole('button', { name: /^rejoin$/i })).not.toBeInTheDocument();
	});

	it('shows temp_unavailable countdown chip when buffer has tempUnavailable state', async () => {
		const net = createNetwork({ networkId: 'net1' });
		net.buffers.push(createBuffer({ name: '#general' }));
		ircState.networks.push(net);
		ircState.activeBuffer.networkId = 'net1';
		ircState.activeBuffer.bufferName = '#general';
		// Set a tempUnavailable entry with expiry 30s in the future
		ircState.tempUnavailable['net1:#general'] = { expireAt: Date.now() + 30000 };
		flushSync();

		render(BufferHeader, {
			props: { onAddNetwork: vi.fn(), onEditNetwork: vi.fn(), onJoinChannel: vi.fn(), onToggleMembers: vi.fn() },
		});

		await expect.element(page.getByText(/Server busy/i)).toBeInTheDocument();
		await expect.element(page.getByText(/retry in/i)).toBeInTheDocument();

		// Cleanup
		clearTempUnavailable('net1', '#general');
	});

	it('banned buffer shows error chip + Rejoin + Archive (disconnected recovery state)', async () => {
		const net = createNetwork({ networkId: 'net1' });
		net.buffers.push(createBuffer({ name: '#superbowl', isJoined: false, joinError: 'banned' }));
		ircState.networks.push(net);
		ircState.activeBuffer.networkId = 'net1';
		ircState.activeBuffer.bufferName = '#superbowl';
		flushSync();

		render(BufferHeader, {
			props: { onAddNetwork: vi.fn(), onEditNetwork: vi.fn(), onJoinChannel: vi.fn(), onToggleMembers: vi.fn() },
		});

		// join-error chip with the banned copy
		await expect.element(page.getByText(/You are banned from this channel/i)).toBeInTheDocument();
		// Retry (in chip) + Rejoin (in p.buttons) + Archive
		await expect.element(page.getByRole('button', { name: /Retry/i })).toBeInTheDocument();
		await expect.element(page.getByRole('button', { name: /Rejoin/i })).toBeInTheDocument();
		await expect.element(page.getByRole('button', { name: /Archive/i })).toBeInTheDocument();
	});

	it('joined channel header shows member controls only — no Rejoin, no Archive', async () => {
		const net = createNetwork({ networkId: 'net1' });
		net.buffers.push(createBuffer({ name: '#superbowl', isJoined: true, users: [createMember({})] }));
		ircState.networks.push(net);
		ircState.activeBuffer.networkId = 'net1';
		ircState.activeBuffer.bufferName = '#superbowl';
		flushSync();

		render(BufferHeader, {
			props: { onAddNetwork: vi.fn(), onEditNetwork: vi.fn(), onJoinChannel: vi.fn(), onToggleMembers: vi.fn() },
		});

		await expect.element(page.getByRole('button', { name: /Members list/i })).toBeInTheDocument();
		await expect(page.getByRole('button', { name: /Rejoin/i })).not.toBeInTheDocument();
		await expect(page.getByRole('button', { name: /Archive/i })).not.toBeInTheDocument();
	});

	describe('server-buffer live pill', () => {
		const props = { onAddNetwork: vi.fn(), onEditNetwork: vi.fn(), onJoinChannel: vi.fn(), onToggleMembers: vi.fn() };
		const pill = () => document.querySelector('[data-testid="server-pill"]');
		const kv = () => document.querySelector('[data-testid="server-kv"]');

		it('connected: "Connected · <uptime>" with lag / egress / channel count', async () => {
			const net = createNetwork({
				networkId: 'net1', connected: true, connectionState: 'connected',
				connectedAtMs: Date.now() - (3 * 3600 + 12 * 60 + 7) * 1000,
				lagMs: 41, egressLabel: 'mullvad-us-nyc',
			});
			net.buffers.push(
				createBuffer({ name: '_server', type: 'server' }),
				createBuffer({ name: '#a', isJoined: true }),
				createBuffer({ name: '#b', isJoined: true }),
				createBuffer({ name: '#parted', isJoined: false }),
				createBuffer({ name: 'nickserv', type: 'query' }),
			);
			ircState.networks.push(net);
			ircState.activeBuffer.networkId = 'net1';
			ircState.activeBuffer.bufferName = '_server';
			flushSync();
			render(BufferHeader, { props });

			expect(pill()).toHaveAttribute('data-state', 'connected');
			expect(pill()).toHaveTextContent('Connected · 3h 12m');
			expect(pill()?.classList.contains('busy')).toBe(false);
			expect(pill()?.classList.contains('off')).toBe(false);
			expect(kv()).toHaveTextContent('lag 41 ms · egress mullvad-us-nyc · 2 channels');
		});

		it('connected without telemetry: plain "Connected" and only the channel count', async () => {
			const net = createNetwork({ networkId: 'net1', connected: true, connectionState: 'connected' });
			net.buffers.push(createBuffer({ name: '_server', type: 'server' }), createBuffer({ name: '#a', isJoined: true }));
			ircState.networks.push(net);
			ircState.activeBuffer.networkId = 'net1';
			ircState.activeBuffer.bufferName = '_server';
			flushSync();
			render(BufferHeader, { props });

			expect(pill()).toHaveTextContent(/^Connected$/);
			expect(kv()).toHaveTextContent(/^1 channel$/);
		});

		it('connected: prefers the human egress location over the internal slot label', async () => {
			const net = createNetwork({
				networkId: 'net1', connected: true, connectionState: 'connected',
				lagMs: 41, egressLabel: 'de', egressLocation: 'Berlin, Germany',
			});
			net.buffers.push(createBuffer({ name: '_server', type: 'server' }), createBuffer({ name: '#a', isJoined: true }));
			ircState.networks.push(net);
			ircState.activeBuffer.networkId = 'net1';
			ircState.activeBuffer.bufferName = '_server';
			flushSync();
			render(BufferHeader, { props });

			expect(kv()).toHaveTextContent('egress Berlin, Germany');
		});

		it('connecting: "Connecting · <phase>" with pulsing dot, elapsed and host:port via egress', async () => {
			const net = createNetwork({
				networkId: 'net1', connected: false, connectionState: 'connecting',
				host: 'irc.supernets.org', port: 6697, egressLabel: 'mullvad-us-nyc',
			});
			net.buffers.push(createBuffer({ name: '_server', type: 'server' }));
			ircState.networks.push(net);
			const t0 = Date.now() - 4200;
			ircState.messages['net1:_server'] = [
				createMessage({ command: 'NOTICE', nick: '', phase: 'queued', text: 'Queued', t: t0 }),
				createMessage({ command: 'NOTICE', nick: '', phase: 'resolving', text: 'Resolving', t: t0 + 14 }),
				createMessage({ command: 'NOTICE', nick: '', phase: 'tls', text: 'TLS handshake', t: t0 + 312 }),
			];
			ircState.activeBuffer.networkId = 'net1';
			ircState.activeBuffer.bufferName = '_server';
			flushSync();
			render(BufferHeader, { props });

			expect(pill()).toHaveAttribute('data-state', 'busy');
			expect(pill()?.classList.contains('busy')).toBe(true);
			expect(pill()).toHaveTextContent('Connecting · tls');
			expect(kv()).toHaveTextContent(/^4\.\ds elapsed · irc\.supernets\.org:6697 via mullvad-us-nyc$/);
		});

		it('waiting_to_retry: "Disconnected · retry in Ns" with last error', async () => {
			const net = createNetwork({
				networkId: 'net1', connected: false, connectionState: 'waiting_to_retry',
				retryStatus: { attemptCount: 2, nextRetryAtMs: Date.now() + 8000, delayMs: 8000 },
				failInfo: { type: 'socket_closed', reason: 'ECONNRESET' },
			});
			net.buffers.push(createBuffer({ name: '_server', type: 'server' }));
			ircState.networks.push(net);
			ircState.activeBuffer.networkId = 'net1';
			ircState.activeBuffer.bufferName = '_server';
			flushSync();
			render(BufferHeader, { props });

			expect(pill()).toHaveAttribute('data-state', 'retry');
			expect(pill()?.classList.contains('off')).toBe(true);
			expect(pill()).toHaveTextContent(/^Disconnected · retry in [78]s$/);
			expect(kv()).toHaveTextContent(/^last error ECONNRESET$/);
		});

		it('failed: "Failed · TLS" with last error and attempt count', async () => {
			const net = createNetwork({
				networkId: 'net1', connected: false, connectionState: 'disconnected',
				retryStatus: { attemptCount: 5, nextRetryAtMs: 0, delayMs: 0 },
				failInfo: { type: 'ssl_certificate_error', reason: 'CERT_HAS_EXPIRED', sslVerifyError: { type: 'x509', error: 'certificate has expired' } },
			});
			net.buffers.push(createBuffer({ name: '_server', type: 'server' }));
			ircState.networks.push(net);
			ircState.activeBuffer.networkId = 'net1';
			ircState.activeBuffer.bufferName = '_server';
			flushSync();
			render(BufferHeader, { props });

			expect(pill()).toHaveAttribute('data-state', 'failed');
			expect(pill()).toHaveTextContent(/^Failed · TLS$/);
			expect(kv()).toHaveTextContent(/^last error CERT_HAS_EXPIRED · 5 attempts$/);
		});

		it('disconnected by the user: plain "Disconnected", empty kv', async () => {
			const net = createNetwork({ networkId: 'net1', connected: false, connectionState: 'disconnected', disconnectReason: 'You disconnected' });
			net.buffers.push(createBuffer({ name: '_server', type: 'server' }));
			ircState.networks.push(net);
			ircState.activeBuffer.networkId = 'net1';
			ircState.activeBuffer.bufferName = '_server';
			flushSync();
			render(BufferHeader, { props });

			expect(pill()).toHaveAttribute('data-state', 'off');
			expect(pill()).toHaveTextContent(/^Disconnected$/);
			expect(kv()).toHaveTextContent(/^$/);
		});

		it('is absent on channel buffers', async () => {
			const net = createNetwork({ networkId: 'net1', connected: true });
			net.buffers.push(createBuffer({ name: '#general' }));
			ircState.networks.push(net);
			ircState.activeBuffer.networkId = 'net1';
			ircState.activeBuffer.bufferName = '#general';
			flushSync();
			render(BufferHeader, { props });

			expect(pill()).toBeNull();
		});
	});
});
