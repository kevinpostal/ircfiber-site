import { describe, expect, it, vi } from 'vitest';

vi.mock('/src/stores/wsConnection.svelte.ts', () => ({
  connectWebSocket: vi.fn(),
  disconnectWebSocket: vi.fn(),
  sendRaw: vi.fn(),
  sendMessage: vi.fn(),
  sendEditMessage: vi.fn(),
  requestSync: vi.fn(),
  requestSwitchBuffer: vi.fn(),
  sendJson: vi.fn(),
  wsState: { value: 'disconnected' },
  maxEidTracker: { value: 0 },
  setMaxEid: vi.fn(),
  startXHRFallback: vi.fn(),
  stopXHRFallback: vi.fn(),
}));

import { connectWebSocket } from '/src/stores/wsConnection.svelte.ts';

describe('mock debug', () => {
  it('connectWebSocket has mock property', () => {
    const wsMock = connectWebSocket as unknown as {
      mock: { calls: Array<Array<unknown>> };
    };
    expect(typeof connectWebSocket).toBe('function');
    console.log('mock =', typeof wsMock.mock);
  });
});
