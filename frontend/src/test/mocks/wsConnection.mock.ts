import { vi } from 'vitest';

export function make_mock_ws_connection() {
  return {
    sendRaw: vi.fn(),
    sendMessage: vi.fn(),
    requestSync: vi.fn(),
    requestSwitchBuffer: vi.fn(),
    disconnectWebSocket: vi.fn(),
    isConnected: vi.fn(() => true),
    connectWebSocket: vi.fn(),
  };
}
