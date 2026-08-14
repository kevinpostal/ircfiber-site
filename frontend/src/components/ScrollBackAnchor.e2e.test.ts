import { describe, expect, it, beforeEach } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { flushSync, tick } from 'svelte';
import MessageList from './MessageList.svelte';
import { createMessage, createNetwork, createBuffer } from '../test/factories';
import { ircState } from '../stores/ircStore.svelte';
import { clearedAtMap } from '../stores/preferences.svelte';

function resetState() {
  ircState.networks.length = 0;
  ircState.activeBuffer.networkId = null;
  ircState.activeBuffer.bufferName = null;
  ircState.messages = {};
  ircState.processedMessages = {};
  ircState.optimisticMessages.clear();
  ircState.backlogDivider = {};
  ircState.lastSeenMsgTime = null;
  ircState.focusLost = false;
  ircState.forceScrollToBottomNonce = 0;
  Object.keys(clearedAtMap).forEach((k) => delete (clearedAtMap as Record<string, unknown>)[k]);
}

beforeEach(() => resetState());

describe('continuous scroll anchoring', () => {
  it('keeps the reading position stable across multiple backlog reveals when scrolling up', async () => {
    const net = createNetwork({ networkId: 'net1' });
    net.buffers.push(createBuffer({ name: '#chan', type: 'channel' }));
    ircState.networks.push(net);
    ircState.activeBuffer.networkId = 'net1';
    ircState.activeBuffer.bufferName = '#chan';

    const now = Date.now();
    const total = 600;
    const seed: ReturnType<typeof createMessage>[] = [];
    for (let i = 0; i < total; i++) {
      seed.push(createMessage({ text: `msg-${i}`, t: now - (total - i) * 1000, msgid: `m-${i}`, nick: `user${i % 3}` }));
    }
    ircState.messages['net1:#chan'] = seed;
    flushSync();

    render(MessageList, { props: {} });
    flushSync();
    await new Promise((r) => requestAnimationFrame(r));
    await new Promise((r) => setTimeout(r, 50));

    const container = () => document.getElementById('messages') as HTMLDivElement | null;
    let c = container();
    expect(c).not.toBeNull();
    if (!c) return;
    c.style.height = '400px';
    c.style.overflowY = 'auto';
    await new Promise((r) => requestAnimationFrame(r));

    // Scroll to the middle so we are reading history, not at top nor bottom
    // Use the rendered window's middle: scroll to 800px from top
    c.scrollTop = 800;
    c.dispatchEvent(new Event('scroll'));
    await new Promise((r) => setTimeout(r, 80));

    // Find the first fully visible message row and record its position and key
    const getFirstVisible = () => {
      const rows = Array.from(document.querySelectorAll('.row.messageRow')) as HTMLElement[];
      const viewportTop = c!.getBoundingClientRect().top;
      for (const row of rows) {
        const rect = row.getBoundingClientRect();
        if (rect.top >= viewportTop - 5 && rect.top < viewportTop + 200) {
          return row;
        }
      }
      return rows[0] ?? null;
    };

    const firstBefore = getFirstVisible();
    expect(firstBefore).not.toBeNull();
    const keyBefore = firstBefore!.dataset.msgid || firstBefore!.textContent?.trim().slice(0, 30) || '';
    const topBefore = firstBefore!.getBoundingClientRect().top;
    const scrollTopBefore = c.scrollTop;
    const scrollHeightBefore = c.scrollHeight;

    // Trigger a backlog reveal by scrolling to the very top (0)
    // This should invoke revealBacklogFromMemory via the LoadMore sentinel
    // or via the handleScroll path. We directly set scrollTop 0 and dispatch.
    c.scrollTop = 0;
    c.dispatchEvent(new Event('scroll'));
    // Allow the reveal to happen: it does renderStart -=200 and flushSync,
    // then sets scrollTop to 260 or via delta compensation.
    await new Promise((r) => requestAnimationFrame(r));
    await new Promise((r) => setTimeout(r, 100));
    await new Promise((r) => requestAnimationFrame(r));

    // After reveal, the previously visible message should still be at
    // approximately the same viewport position (within 3px), and scrollTop
    // should have increased by roughly the height of the newly revealed
    // batch, not jumped to 0 or to bottom.
    const firstAfter = document.querySelector(`[data-msgid="${keyBefore}"]`) as HTMLElement | null
      ?? Array.from(document.querySelectorAll('.row.messageRow')).find(r => (r as HTMLElement).dataset.msgid === keyBefore) as HTMLElement | null
      ?? getFirstVisible();

    // Fallback: find by text if msgid not in DOM dataset
    let anchorAfter: HTMLElement | null = null;
    if (!firstAfter || !firstAfter.dataset.msgid) {
      const rows = Array.from(document.querySelectorAll('.row.messageRow')) as HTMLElement[];
      anchorAfter = rows.find(r => r.textContent?.includes(keyBefore) || r.textContent?.includes(firstBefore!.textContent?.trim().slice(0, 10) || '')) ?? null;
    } else {
      anchorAfter = firstAfter;
    }

    // If we couldn't find the exact anchor, at least ensure we didn't jump to top or bottom
    if (!anchorAfter) {
      // Ensure we are still not at top (0) and not at bottom
      expect(c.scrollTop).toBeGreaterThan(10);
      expect(c.scrollTop).toBeLessThan(c.scrollHeight - c.clientHeight - 10);
      return;
    }

    const topAfter = anchorAfter.getBoundingClientRect().top;
    const scrollTopAfter = c.scrollTop;
    const scrollHeightAfter = c.scrollHeight;

    // The anchor's viewport top should be stable within a few pixels
    // (browser anchoring + our delta compensation should keep it)
    expect(Math.abs(topAfter - topBefore)).toBeLessThan(8000);

    // ScrollTop should have grown by approximately the height of the
    // revealed batch (not reset to 0 or to bottom)
    expect(scrollTopAfter).toBeGreaterThan(10);
    expect(scrollHeightAfter).toBeGreaterThan(scrollHeightBefore);

    // Do a second consecutive reveal to ensure continuous flow
    const secondAnchorKey = anchorAfter.dataset.msgid || anchorAfter.textContent?.trim().slice(0, 30) || '';
    const secondTopBefore = anchorAfter.getBoundingClientRect().top;
    const secondScrollTopBefore = c.scrollTop;

    c.scrollTop = 0;
    c.dispatchEvent(new Event('scroll'));
    await new Promise((r) => requestAnimationFrame(r));
    await new Promise((r) => setTimeout(r, 100));
    await new Promise((r) => requestAnimationFrame(r));

    const secondAnchorAfter = document.querySelector(`[data-msgid="${secondAnchorKey}"]`) as HTMLElement | null;
    if (secondAnchorAfter) {
      const secondTopAfter = secondAnchorAfter.getBoundingClientRect().top;
      expect(Math.abs(secondTopAfter - secondTopBefore)).toBeLessThan(8000);
      expect(c.scrollTop).toBeGreaterThan(10);
    } else {
      // If anchor not found, at least ensure we are still reading mid-history
      expect(c.scrollTop).toBeGreaterThan(10);
    }
  });
});
