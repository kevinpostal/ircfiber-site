import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import { flushSync } from 'svelte';
import Img2IrcDialog from './Img2IrcDialog.svelte';
import { ircState } from '../stores/ircStore.svelte';

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
  createIrcArtSave: vi.fn(async () => ({})),
  updateIrcArtSave: vi.fn(async () => ({})),
  normalizeMessage: vi.fn((m: unknown) => m),
}));

vi.mock('/src/stores/wsConnection.svelte.ts', () => ({
  sendRaw: vi.fn(),
  sendJson: vi.fn(),
  sendMessage: vi.fn(),
  requestSync: vi.fn(),
  requestSwitchBuffer: vi.fn(),
  connectWebSocket: vi.fn(),
  disconnectWebSocket: vi.fn(),
  wsState: { value: 'disconnected' },
  maxEidTracker: { value: 0 },
  setMaxEid: vi.fn(),
}));

import { sendMessage } from '../stores/wsConnection.svelte.ts';

// 'z' survives the dialog's blank-line filter (it strips IRC codes,
// hex digits and spaces), so every line below is a real send.
const LINES = [
  'Row z-one',
  'Row z-two',
  'Row z-three',
  'Row z-four',
  'Row z-five',
  'Row z-six',
  'Row z-seven',
  'Row z-eight',
];
const ART = [...LINES.slice(0, 4), '', ...LINES.slice(4)].join('\n');

function resetState(): void {
  ircState.networks.length = 0;
  ircState.activeBuffer.networkId = 'net1';
  ircState.activeBuffer.bufferName = '#chan';
  for (const k of Object.keys(ircState.messages)) delete ircState.messages[k];
}

beforeEach(() => {
  resetState();
  vi.clearAllMocks();
  flushSync();
});

describe('Img2IrcDialog send', () => {
  it('dispatches every art line with no inter-line sleep', async () => {
    const file = new File([], 'dummy.png', { type: 'image/png' });
    const onClose = vi.fn();
    // editId + dummy file keeps convert() from touching initialArt.
    render(Img2IrcDialog, { file, filename: 'dummy.png', onClose, editId: 'e1', initialArt: ART });

    const sendBtn = page.getByTestId('left-send');
    await expect.element(sendBtn).toBeInTheDocument();

    await sendBtn.click();

    // Proof there is no artificial pacing: send() is synchronous, so by
    // the time the click resolves ALL lines are already dispatched — no
    // waiting, no timer advancement. The old burst loop (5x35ms then
    // 110ms/line) would have exactly 1 call at this point.
    expect(vi.mocked(sendMessage)).toHaveBeenCalledTimes(LINES.length);
    LINES.forEach((line, i) => {
      expect(vi.mocked(sendMessage)).toHaveBeenNthCalledWith(
        i + 1,
        'net1',
        '#chan',
        line,
        expect.any(String),
      );
    });
    // The blank line is skipped, and the dialog closes immediately
    // instead of after a ~1s paced loop.
    expect(onClose).toHaveBeenCalledTimes(1);
  }, 15000);
});
