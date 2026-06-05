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
  };
}
