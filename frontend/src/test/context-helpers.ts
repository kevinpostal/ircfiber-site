import { vi } from 'vitest';

/**
 * Create a mock WebSocket connection for tests. The wsConnection module
 * exports `sendRaw`, `sendMessage`, `requestSync`, etc. as bare functions,
 * so the mock is just an object with vi.fn() stubs.
 */
export function create_mock_ws_connection(overrides = {}) {
  return {
    sendRaw: vi.fn(),
    sendMessage: vi.fn(),
    requestSync: vi.fn(),
    requestSwitchBuffer: vi.fn(),
    disconnectWebSocket: vi.fn(),
    isConnected: vi.fn(() => true),
    connectWebSocket: vi.fn(),
    ...overrides,
  };
}

/**
 * Create a mock REST API client. The api.ts module exports `loadHistory`,
 * `fetchMe`, `fetchHealth`, etc. Each is a function returning a promise.
 */
export function create_mock_api(overrides = {}) {
  return {
    loadHistory: vi.fn(async () => []),
    fetchMe: vi.fn(async () => ({ username: 'tester', email: 'tester@test.local' })),
    fetchHealth: vi.fn(async () => ({ status: 'healthy', services: {} })),
    reconnectNetwork: vi.fn(async () => undefined),
    disconnectNetwork: vi.fn(async () => undefined),
    joinChannel: vi.fn(async () => undefined),
    addNetwork: vi.fn(async () => undefined),
    updateNetwork: vi.fn(async () => undefined),
    deleteNetwork: vi.fn(async () => undefined),
    fetchBouncer: vi.fn(async () => ({ enabled: true, host: 'bnc.test', port: 7000, tls: true, password: null })),
    generateBouncerPassword: vi.fn(async () => ({ enabled: true, host: 'bnc.test', port: 7000, tls: true, password: 'bnc:token' })),
    revokeBouncerPassword: vi.fn(async () => undefined),
    // ircStore imports this for the WebSocket-sync message normalization
    // path. Default to a pass-through so consumers that don't drive the
    // sync path don't need to think about it; tests that exercise the
    // path can override via the ...overrides spread.
    normalizeMessage: vi.fn((m: unknown) => m),
    ...overrides,
  };
}
