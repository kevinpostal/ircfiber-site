import { vi } from 'vitest';
import type { IRCMessage } from '../../types';

export function make_mock_api() {
  return {
    loadHistory: vi.fn(async (): Promise<IRCMessage[]> => []),
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
    // See context-helpers.ts for the rationale.
    normalizeMessage: vi.fn((m: unknown) => m),
  };
}
