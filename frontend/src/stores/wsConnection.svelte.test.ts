// ── W5-T01: WS -> XHR stream fallback ──
// Tests for XHR long-poll fallback when WebSocket connection fails.
// Mirrors IRCCloud's SocketStreamHandler -> XHRStreamHandler pattern.
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { globalPrefs, DEFAULT_PREFS } from './preferences.svelte';

// The XHR functions are exported from wsConnection; import the real module
// (not mocked). We mock fetch + WebSocket at the global level instead.
import {
	startXHRFallback,
	stopXHRFallback,
	connectWebSocket,
	disconnectWebSocket,
	maxEidTracker,
	setMaxEid,
	wsState,
} from './wsConnection.svelte';

beforeEach(() => {
	Object.assign(globalPrefs, DEFAULT_PREFS);
	maxEidTracker.value = 0;
});

afterEach(() => {
	stopXHRFallback();
	disconnectWebSocket();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

// ── Unit tests for XHR lifecycle functions ──

describe('XHR fallback lifecycle (W5-T01)', () => {
	it('startXHRFallback does nothing when xhrFallback flag is disabled', () => {
		globalPrefs.featureFlags.xhrFallback.enabled = false;
		const fetchSpy = vi.spyOn(globalThis, 'fetch');

		startXHRFallback();

		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it('startXHRFallback fetches /api/events when flag is enabled', async () => {
		globalPrefs.featureFlags.xhrFallback.enabled = true;
		const fetchSpy = vi.spyOn(globalThis, 'fetch')
			.mockResolvedValue(new Response('[]', { status: 200 }));

		startXHRFallback();

		// Poll should start immediately
		await vi.waitFor(() => {
			expect(fetchSpy).toHaveBeenCalledWith(
				expect.stringMatching(/\/api\/events\?since=\d+/),
				expect.objectContaining({ signal: expect.any(AbortSignal) })
			);
		});
	});

	it('startXHRFallback uses maxEidTracker.value as since param', async () => {
		globalPrefs.featureFlags.xhrFallback.enabled = true;
		setMaxEid(12345);
		const fetchSpy = vi.spyOn(globalThis, 'fetch')
			.mockResolvedValue(new Response('[]', { status: 200 }));

		startXHRFallback();

		await vi.waitFor(() => {
			expect(fetchSpy).toHaveBeenCalledWith(
				'/api/events?since=12345',
				expect.any(Object)
			);
		});
	});

	it('stopXHRFallback aborts in-flight fetch', async () => {
		globalPrefs.featureFlags.xhrFallback.enabled = true;
		const abortSpy = vi.spyOn(AbortController.prototype, 'abort');
		const fetchSpy = vi.spyOn(globalThis, 'fetch')
			.mockImplementation(
				() => new Promise(() => {}) // never resolves — simulates hanging request
			);

		startXHRFallback();
		await vi.waitFor(() => {
			expect(fetchSpy).toHaveBeenCalled();
		});

		stopXHRFallback();

		expect(abortSpy).toHaveBeenCalled();
	});

	it('calling startXHRFallback twice does not start a second poll', async () => {
		globalPrefs.featureFlags.xhrFallback.enabled = true;
		const fetchSpy = vi.spyOn(globalThis, 'fetch')
			.mockResolvedValue(new Response('[]', { status: 200 }));

		startXHRFallback();
		startXHRFallback();

		await vi.waitFor(() => {
			expect(fetchSpy).toHaveBeenCalledTimes(1);
		});
	});
});

// ── Helpers: Real WebSocket + fetch stashing ──

/** Create a partial WebSocket mock that satisfies what connectWebSocket uses. */
function createMockWs(): EventTarget {
	const ws = new EventTarget();
	Object.defineProperties(ws, {
		readyState: { value: 0, writable: true },
		send: { value: vi.fn(), writable: true },
		close: { value: vi.fn(), writable: true },
		url: { value: '', writable: true },
	});
	return ws;
}

/**
 * Replace globalThis.WebSocket with a mock constructor.
 * vitest-browser-svelte runs in a headless Chromium where the native
 * WebSocket class is non-configurable; vi.stubGlobal replaces the global
 * reference in a way that survives `new WebSocket()`.
 */
function stubWebSocket(): { mockWs: EventTarget } {
	const mockWs = createMockWs();
	const MockWebSocket = vi.fn(function (this: EventTarget, _url: string) {
		Object.defineProperty(mockWs, 'url', { value: _url });
		return mockWs;
	});
	// @ts-expect-error — partial mock
	MockWebSocket.prototype = {};
	// @ts-expect-error — partial mock
	MockWebSocket.CONNECTING = 0;
	// @ts-expect-error — partial mock
	MockWebSocket.OPEN = 1;
	// @ts-expect-error — partial mock
	MockWebSocket.CLOSING = 2;
	// @ts-expect-error — partial mock
	MockWebSocket.CLOSED = 3;
	vi.stubGlobal('WebSocket', MockWebSocket);
	return { mockWs };
}

// ── Integration: XHR processes events through handleResponse ──

describe('XHR processes events (W5-T01)', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('forwards array events from XHR to message callback', async () => {
		globalPrefs.featureFlags.xhrFallback.enabled = true;
		const onMessage = vi.fn();
		const { mockWs } = stubWebSocket();

		vi.spyOn(globalThis, 'fetch')
			.mockResolvedValue(
				new Response(JSON.stringify([
					{ type: 'event1', eid: 100 },
					{ type: 'event2', eid: 200 },
				]), { status: 200 })
			);

		connectWebSocket(onMessage);

		// Simulate WS open so messageCallback is active
		(mockWs as unknown as { readyState: number }).readyState = 1; // OPEN
		mockWs.dispatchEvent(new Event('open'));

		startXHRFallback();

		// Fetch resolves with array — each item flows through handleResponse
		// which routes non-request/response messages to onMessage callback
		await vi.waitFor(() => {
			expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'event1', eid: 100 }));
			expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'event2', eid: 200 }));
		});
	});

	it('WS close triggers XHR fallback poll', async () => {
		globalPrefs.featureFlags.xhrFallback.enabled = true;
		const fetchSpy = vi.spyOn(globalThis, 'fetch')
			.mockResolvedValue(new Response('[]', { status: 200 }));
		const { mockWs } = stubWebSocket();

		connectWebSocket(vi.fn());

		// Simulate WS close — reconnect path calls startXHRFallback
		mockWs.dispatchEvent(new Event('close'));

		await vi.waitFor(() => {
			expect(fetchSpy).toHaveBeenCalled();
		});
	});

	it('WS open stops XHR fallback (PM8: no double-delivery window)', async () => {
		globalPrefs.featureFlags.xhrFallback.enabled = true;
		const fetchSpy = vi.spyOn(globalThis, 'fetch')
			.mockResolvedValue(new Response('[]', { status: 200 }));
		const { mockWs } = stubWebSocket();

		connectWebSocket(vi.fn());

		// Close triggers reconnect + XHR
		mockWs.dispatchEvent(new Event('close'));

		await vi.waitFor(() => {
			expect(fetchSpy).toHaveBeenCalled();
		});

		// Simulate WS open — should stop XHR
		(mockWs as unknown as { readyState: number }).readyState = 1; // OPEN
		mockWs.dispatchEvent(new Event('open'));

		// After open, XHR should be stopped — no more fetch calls from the poll loop
		const callCountAfterOpen = fetchSpy.mock.calls.length;
		await new Promise((r) => setTimeout(r, 100));
		expect(fetchSpy.mock.calls.length).toBe(callCountAfterOpen);
	});
});
