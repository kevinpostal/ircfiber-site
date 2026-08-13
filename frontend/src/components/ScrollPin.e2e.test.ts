import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page, userEvent } from 'vitest/browser';
import { flushSync, tick } from 'svelte';
import InputArea from './InputArea.svelte';
import MessageList from './MessageList.svelte';
import { createNetwork, createBuffer } from '../test/factories';
import { ircState } from '../stores/ircStore.svelte';
import { clearedAtMap } from '../stores/preferences.svelte';

vi.mock('/src/stores/api', () => ({
  reconnectNetwork: vi.fn(async () => undefined),
  clearBacklog: vi.fn(async () => undefined),
  disconnectNetwork: vi.fn(async () => undefined),
  fetchMe: vi.fn(async () => ({ username: 'tester', email: 'tester@test.local' })),
  fetchHealth: vi.fn(async () => ({ status: 'healthy', services: {} })),
  loadHistory: vi.fn(async () => []),
  joinChannel: vi.fn(async () => undefined),
  addNetwork: vi.fn(async () => undefined),
  updateNetwork: vi.fn(async () => undefined),
  deleteNetwork: vi.fn(async () => undefined),
  archiveChannel: vi.fn(async () => undefined),
  unarchiveChannel: vi.fn(async () => undefined),
  updateServerlogCollapsed: vi.fn(async () => undefined),
  normalizeMessage: vi.fn((m: unknown) => m),
  editUpload: vi.fn(async () => undefined),
  createIrcArtSave: vi.fn(async () => undefined),
  updateIrcArtSave: vi.fn(async () => undefined),
  fetchIrcArtSave: vi.fn(async () => undefined),
  fetchIrcArtSavesOffset: vi.fn(async () => ({ entries: [], total: 0 })),
  deleteIrcArtSave: vi.fn(async () => undefined),
  fetchUploads: vi.fn(async () => []),
  fetchUploadsOffset: vi.fn(async () => ({ entries: [], total: 0 })),
  deleteUpload: vi.fn(async () => undefined),
  fetchUploadById: vi.fn(async () => undefined),
  createPastebin: vi.fn(async () => undefined),
  fetchPastebinsOffset: vi.fn(async () => ({ entries: [], total: 0 })),
  deletePastebin: vi.fn(async () => undefined),
  pastebinRawUrl: vi.fn(() => ''),
  fetchArchiveNames: vi.fn(async () => ({})),
}));

function resetState(): void {
  ircState.networks.length = 0;
  ircState.activeBuffer.networkId = null;
  ircState.activeBuffer.bufferName = null;
  ircState.messages = {};
  ircState.processedMessages = {};
  ircState.backlogDivider = {};
  ircState.lastSeenMsgTime = null;
  ircState.focusLost = false;
  ircState.forceScrollToBottomNonce = 0;
  ircState.optimisticMessages.clear();
  Object.keys(clearedAtMap).forEach((k) => delete (clearedAtMap as Record<string, unknown>)[k]);
}

describe('Scroll pin while typing 1-0', () => {
  beforeEach(() => {
    resetState();
    vi.clearAllMocks();
  });

  it('typing 1 2 3 4 5 6 7 8 9 0 keeps scroll at bottom and 0 is last visible', async () => {
    const net = createNetwork({ networkId: 'net1', currentNick: 'tester' });
    net.buffers.push(createBuffer({ name: '#chan' }));
    ircState.networks.push(net);
    ircState.activeBuffer.networkId = 'net1';
    ircState.activeBuffer.bufferName = '#chan';
    flushSync();

    // Render both components as user sees them (MessageList + InputArea share same ircState)
    render(MessageList, { props: {} });
    render(InputArea, { props: {} });

    const textarea = page.getByRole('textbox', { name: /message input/i });
    await expect.element(textarea).toBeInTheDocument();

    const container = () => document.getElementById('messages') as HTMLDivElement;
    // Ensure container has height to scroll
    await tick();
    const c0 = container();
    if (c0) {
      c0.style.height = '300px';
      c0.style.overflowY = 'auto';
    }

    const seq = ['1','2','3','4','5','6','7','8','9','0'];
    for (const ch of seq) {
      await userEvent.type(textarea, ch);
      await userEvent.keyboard('{Enter}');
      // Wait for optimistic message to appear
      await expect.element(page.getByText(ch).first()).toBeInTheDocument({ timeout: 2000 });
      // Allow Svelte tick + scroll + rAF to settle
      await tick();
      await new Promise((r) => requestAnimationFrame(r));
      await new Promise((r) => setTimeout(r, 60));
      // Verify scroll is pinned at bottom (within 2px) when messages overflow
      const c = container();
      if (c && c.scrollHeight > c.clientHeight) {
        const atBottom = c.scrollHeight - c.clientHeight - c.scrollTop;
        expect(atBottom, `after sending ${ch} scroll should be at bottom (atBottom=${atBottom} scrollTop=${c.scrollTop} scrollHeight=${c.scrollHeight} clientHeight=${c.clientHeight})`).toBeLessThanOrEqual(2);
      }
    }

    // Final assertions: all 1-0 present in order, 0 last
    for (const ch of seq) {
      await expect.element(page.getByText(ch).first()).toBeInTheDocument();
    }
    // Check order: 0 should be after 9 in DOM
    const texts = Array.from(document.querySelectorAll('.messageRow, [data-testid="message-row"], .msg, [data-msgid]'))
      .map(el => el.textContent || '')
      .join(' ');
    // Simpler: check that the last message element contains 0
    const allRows = document.querySelectorAll('#messages [data-msgid], #messages .messageRow');
    const lastText = allRows[allRows.length - 1]?.textContent || '';
    expect(lastText).toContain('0');

    // Screenshot for visual verification: scroll bar at bottom, 0 visible
    const cFinal = container();
    expect(cFinal).not.toBeNull();
    // Log scroll metrics for debugging
    console.log(`[scroll-pin] final scrollTop=${cFinal!.scrollTop} scrollHeight=${cFinal!.scrollHeight} clientHeight=${cFinal!.clientHeight} atBottom=${cFinal!.scrollHeight - cFinal!.clientHeight - cFinal!.scrollTop}`);
    await expect(page).toHaveScreenshot('scroll-pin-1-0.png', { maxDiffPixelRatio: 0.05 });
    // Also ensure 0 is within viewport (not clipped above)
    const zeroEl = page.getByText('0').first().element() as HTMLElement | null;
    if (zeroEl && cFinal) {
      const rect = zeroEl.getBoundingClientRect();
      const cRect = cFinal.getBoundingClientRect();
      expect(rect.bottom, '0 should be inside viewport bottom').toBeLessThanOrEqual(cRect.bottom + 2);
      expect(rect.top, '0 should be inside viewport').toBeGreaterThanOrEqual(cRect.top - 2);
    }
  }, 15000);
});
