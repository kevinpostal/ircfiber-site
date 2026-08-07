import { globalPrefs } from './preferences.svelte';
import { ircState, markNetworkSeen } from './ircStore.svelte';

// ── Stream state machine ──
// Mirrors IRCCloud's BackendController lifecycle:
//   disconnected → connecting → connected → [error] → reconnecting → connected
export type StreamState =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'reconnecting';

// IRCCloud-style maxEid: tracks the highest eid seen across all events.
// On reconnect, this is sent as `since` so the server only streams events
// with eid > maxEid — guarantees no gaps and no duplicates after resume.
//
// The 2026-07-07 redesign adds a second role: the client periodically
// sends `ack {eid: maxEid}` to the server so the live event listener
// can filter "the client already has this" events without the client
// ever seeing the same event twice over the WS.
export const maxEidTracker = $state<{ value: number }>({ value: 0 });

export function setMaxEid(eid: number): void {
    if (eid > maxEidTracker.value) maxEidTracker.value = eid;
}

let socket: WebSocket | null = null;

// ── 2026-07-07 redesign: periodic ack so the server can filter live
// events by `eid > lastDeliveredEid`. The client sends `ack {eid}`
// every 5s while connected, plus a final ack on close (best-effort).
// The server's `ircPoolDispatch` listener uses `lastDeliveredEid` to
// drop events the client already has — so we never see the same
// event twice over the WS.
//
// A gap (eid jump > 25) triggers /api/oob to recover from MongoDB
// directly. See wsHoleDetector.ts.
let ackInterval: ReturnType<typeof setInterval> | null = null;
let ackSendInFlight = false;

function startAckTimer(): void {
    stopAckTimer();
    if (ackInterval) return;
    ackInterval = setInterval(() => {
        if (ackSendInFlight) return;
        if (!isConnected()) return;
        const eid = maxEidTracker.value;
        if (eid <= 0) return;
        ackSendInFlight = true;
        try {
            sendJson({ cmd: 'ack', eid });
        } finally {
            // The send is fire-and-forget; mark not-in-flight next tick.
            // Use a microtask via setTimeout(0) so we don't re-arm before
            // the socket has had a chance to flush.
            setTimeout(() => { ackSendInFlight = false; }, 0);
        }
    }, 5_000);
}

function stopAckTimer(): void {
    if (ackInterval) {
        clearInterval(ackInterval);
        ackInterval = null;
    }
}

function sendFinalAck(): void {
    const eid = maxEidTracker.value;
    if (eid > 0 && isConnected()) {
        try {
            sendJson({ cmd: 'ack', eid });
        } catch { /* best-effort */ }
    }
}

// IRCCloud-style message queue: messages sent before the WebSocket is
// ready are queued and flushed on open. Prevents losing messages during
// reconnection (e.g. a DM sent right after clicking a user).
let messageQueue: string[] = [];
let reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
let reconnectDelay = 3000;

// ── XHR long-poll fallback (W5-T01) ──
// Mirrors IRCCloud's XHRStreamHandler: when WebSocket fails, fall back to
// polling /api/events?since=<maxEid> for uninterrupted event delivery.
let xhrFallbackController: AbortController | null = null;

export function startXHRFallback(): void {
  if (!globalPrefs.featureFlags.xhrFallback?.enabled) return;
  if (xhrFallbackController) return; // already running

  xhrFallbackController = new AbortController();

  const poll = async () => {
    if (xhrFallbackController?.signal.aborted) return;

    try {
      const response = await fetch(`/api/events?since=${maxEidTracker.value}`, {
        signal: xhrFallbackController.signal,
      });
      const data = await response.json();
      if (Array.isArray(data)) {
        for (const item of data) {
          handleResponse(item as Record<string, unknown>);
        }
      } else if (data && typeof data === 'object') {
        handleResponse(data as Record<string, unknown>);
      }
      if (!xhrFallbackController?.signal.aborted) poll();
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        return; // intentional abort via stopXHRFallback
      }
      // Transient error — retry after 3s (IRCCloud-style backoff)
      if (!xhrFallbackController?.signal.aborted) {
        setTimeout(poll, 3000);
      }
    }
  };
  poll();
}

export function stopXHRFallback(): void {
  if (xhrFallbackController) {
    xhrFallbackController.abort();
    xhrFallbackController = null;
  }
}

let messageCallback: ((data: unknown) => void) | null = null;
let openCallback: (() => void) | null = null;
let closeCallback: (() => void) | null = null;
let streamStateCallbacks: ((state: StreamState) => void)[] = [];

// ── Reactive stream state ──
// Wrapped in an object so we can export without violating Svelte 5's
// constraint that exported $state variables cannot be reassigned.
// Consumers should read wsState.value and call setStreamState() to update.
export const wsState = $state<{ value: StreamState }>({ value: 'disconnected' });

function setStreamState(state: StreamState): void {
  // IRCCloud-style reconnect handshake: when the stream comes back to
  // 'connected' after having been 'disconnected'/'reconnecting', the
  // next message flood will refresh lastSeenAt per-network. Until that
  // flood arrives the user would see every network flagged as stale,
  // which is misleading — they're fresh again. Refresh all known
  // networks here so the stale pill clears promptly after a reconnect.
  if (state === 'connected' && wsState.value !== 'connected') {
    const now = Date.now();
    for (const net of ircState.networks) {
      net.lastSeenAt = now;
    }
  }
  wsState.value = state;
  for (const cb of streamStateCallbacks) cb(state);
}

export function onStreamState(cb: (state: StreamState) => void): () => void {
  streamStateCallbacks.push(cb);
  return () => { streamStateCallbacks = streamStateCallbacks.filter(c => c !== cb); };
}

// ── Socket request/response correlation ──
let reqidCounter = 0;
const pendingRequests = new Map<string, {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}>();

/** Send a command and get a Promise that resolves when the gateway responds. */
export function sendRequest(cmd: string, payload: Record<string, unknown> = {}): Promise<unknown> {
  const _reqid = `req_${++reqidCounter}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingRequests.delete(_reqid);
      reject(new Error(`Request ${_reqid} timed out`));
    }, 15000);
    pendingRequests.set(_reqid, { resolve, reject, timer });
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ _reqid, cmd, ...payload }));
    } else {
      clearTimeout(timer);
      pendingRequests.delete(_reqid);
      reject(new Error('WebSocket not connected'));
    }
  });
}

function handleResponse(data: Record<string, unknown>): void {
  const reqid = data._reqid as string | undefined;
  if (reqid && pendingRequests.has(reqid)) {
    const pending = pendingRequests.get(reqid)!;
    clearTimeout(pending.timer);
    pendingRequests.delete(reqid);
    if (data._error) {
      pending.reject(new Error(data._error as string));
    } else {
      pending.resolve(data);
    }
    return;
  }
  // Not a request/response — pass to message callback
  if (messageCallback) messageCallback(data);
}

// ── WebSocket lifecycle ──

export function connectWebSocket(
  onMessage: (data: unknown) => void,
  onOpen?: () => void,
  onClose?: () => void
): WebSocket {
  if (socket && socket.readyState !== WebSocket.CLOSED) {
    return socket;
  }
  setStreamState('connecting');
  // VITE_WS_BASE allows swapping to Python gateway (Step 3); default is same host /ws behind Caddy.
  const viteWsEnv = import.meta.env as { VITE_WS_BASE?: string };
  const baseWs = viteWsEnv.VITE_WS_BASE ?? `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/ws`;
  const wsUrl = baseWs;
  // IRCCloud-style stream resume: send maxEid so the server only
  // streams events with eid > since — no gaps, no duplicates.
  const url = maxEidTracker.value > 0 ? `${wsUrl}?since=${maxEidTracker.value}` : wsUrl;

  messageCallback = onMessage;
  if (onOpen) openCallback = onOpen;
  if (onClose) closeCallback = onClose;

  socket.addEventListener('open', () => {
    // PM8 mitigation: stop XHR BEFORE WS handshake completes so there
    // is no window where both paths could deliver the same event.
    stopXHRFallback();
    reconnectDelay = 3000;
    setStreamState('connected');
    if (openCallback) openCallback();
    // Flush any messages queued while the WebSocket was closed
    flushQueue();
    // 2026-07-07: start the ack timer so the server can filter live
    // events by `lastDeliveredEid`. The first ack fires after 5s;
    // the gap covers the time the client needs to process the initial
    // stat_user / networks / sync / state-dump / replay batch.
    startAckTimer();
  });

  socket.addEventListener('message', (event) => {
    try {
      const data = JSON.parse(event.data);
      if (Array.isArray((data as any).batch)) {
        // Batch of events — process each one individually
        for (const item of (data as any).batch) {
          handleResponse(item as Record<string, unknown>);
        }
      } else {
        handleResponse(data as Record<string, unknown>);
      }
    } catch (e) {
      console.error('WS parse error:', e);
    }
  });

  socket.addEventListener('close', () => {
    // 2026-07-07: best-effort final ack so the server knows the
    // exact cursor at disconnect. If the WS is already gone this
    // throws silently — that's fine, the server will see the
    // unacked gap in /api/health and the next replay will recover.
    sendFinalAck();
    stopAckTimer();
    if (closeCallback) closeCallback();
    if (!reconnectTimeout) {
      setStreamState('reconnecting');
      // Start XHR long-poll fallback to bridge the gap until WS reconnects
      startXHRFallback();
      reconnectTimeout = setTimeout(() => {
        reconnectTimeout = null;
        reconnectDelay = Math.min(reconnectDelay * 2, 30000);
        connectWebSocket(onMessage, onOpen, onClose);
      }, reconnectDelay);
    }
  });

  socket.addEventListener('error', (e) => {
    console.error('WS error:', e);
  });

  return socket;
}

export function disconnectWebSocket(): void {
    // Reject all pending requests
    for (const [reqid, pending] of pendingRequests) {
        clearTimeout(pending.timer);
        pending.reject(new Error('WebSocket disconnected'));
        pendingRequests.delete(reqid);
    }
    if (reconnectTimeout) {
        clearTimeout(reconnectTimeout);
        reconnectTimeout = null;
    }
    stopAckTimer();
    if (socket) {
        socket.close();
        socket = null;
    }
    setStreamState('disconnected');
}

export function isConnected(): boolean {
  return socket !== null && socket.readyState === WebSocket.OPEN;
}

// ── Fire-and-forget sends ──

function doSend(payload: string): void {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(payload);
  } else {
    // Queue for flush on next WebSocket open (IRCCloud-style)
    if (messageQueue.length < 500) messageQueue.push(payload);
  }
}

function flushQueue(): void {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  for (const msg of messageQueue) {
    socket.send(msg);
  }
  messageQueue = [];
}

export function sendRaw(networkId: string, line: string): void {
  doSend(JSON.stringify({ cmd: 'raw', network: networkId, text: line }));
}

export function sendMessage(networkId: string, target: string, text: string, label?: string): void {
  doSend(JSON.stringify({ cmd: 'msg', network: networkId, target, text, label }));
}

export function sendEditMessage(networkId: string, target: string, text: string, originalLabel: string): void {
  doSend(JSON.stringify({ cmd: 'editmsg', network: networkId, target, text, label: originalLabel }));
}

/** Fire-and-forget JSON send (no response expected). */
export function sendJson(data: Record<string, unknown>): void {
  doSend(JSON.stringify(data));
}

export function requestSync(): void {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ cmd: 'sync' }));
  }
}

export function requestSwitchBuffer(networkId: string, channel: string): void {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ cmd: 'buffer', network: networkId, channel }));
  }
}
