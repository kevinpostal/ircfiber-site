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
export const maxEidTracker = $state<{ value: number }>({ value: 0 });

export function setMaxEid(eid: number): void {
  if (eid > maxEidTracker.value) maxEidTracker.value = eid;
}

let socket: WebSocket | null = null;

// IRCCloud-style message queue: messages sent before the WebSocket is
// ready are queued and flushed on open. Prevents losing messages during
// reconnection (e.g. a DM sent right after clicking a user).
let messageQueue: string[] = [];
let reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
let reconnectDelay = 3000;
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
  const wsUrl = `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/ws`;
  // IRCCloud-style stream resume: send maxEid so the server only
  // streams events with eid > since — no gaps, no duplicates.
  const url = maxEidTracker.value > 0 ? `${wsUrl}?since=${maxEidTracker.value}` : wsUrl;
  socket = new WebSocket(url);

  messageCallback = onMessage;
  if (onOpen) openCallback = onOpen;
  if (onClose) closeCallback = onClose;

  socket.addEventListener('open', () => {
    reconnectDelay = 3000;
    setStreamState('connected');
    if (openCallback) openCallback();
    // Flush any messages queued while the WebSocket was closed
    flushQueue();
  });

  socket.addEventListener('message', (event) => {
    try {
      const data = JSON.parse(event.data);
      handleResponse(data as Record<string, unknown>);
    } catch (e) {
      console.error('WS parse error:', e);
    }
  });

  socket.addEventListener('close', () => {
    if (closeCallback) closeCallback();
    if (!reconnectTimeout) {
      setStreamState('reconnecting');
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
