let socket: WebSocket | null = null;
let reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
let reconnectDelay = 3000;
let messageCallback: ((data: unknown) => void) | null = null;
let openCallback: (() => void) | null = null;
let closeCallback: (() => void) | null = null;

export function connectWebSocket(
  onMessage: (data: unknown) => void,
  onOpen?: () => void,
  onClose?: () => void
): WebSocket {
  if (socket && socket.readyState !== WebSocket.CLOSED) {
    return socket;
  }

  const wsUrl = `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/ws`;
  socket = new WebSocket(wsUrl);

  messageCallback = onMessage;
  if (onOpen) openCallback = onOpen;
  if (onClose) closeCallback = onClose;

  socket.addEventListener('open', () => {
    reconnectDelay = 3000;
    if (openCallback) openCallback();
  });

  socket.addEventListener('message', (event) => {
    try {
      const data = JSON.parse(event.data);
      if (messageCallback) messageCallback(data);
    } catch (e) {
      console.error('WS parse error:', e);
    }
  });

  socket.addEventListener('close', () => {
    if (closeCallback) closeCallback();
    if (!reconnectTimeout) {
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
  if (reconnectTimeout) {
    clearTimeout(reconnectTimeout);
    reconnectTimeout = null;
  }
  if (socket) {
    socket.close();
    socket = null;
  }
}

export function isConnected(): boolean {
  return socket !== null && socket.readyState === WebSocket.OPEN;
}

export function sendRaw(networkId: string, line: string): void {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ cmd: 'raw', network: networkId, text: line }));
  }
}

export function sendMessage(networkId: string, target: string, text: string, label?: string): void {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ cmd: 'msg', network: networkId, target, text, label }));
  }
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
