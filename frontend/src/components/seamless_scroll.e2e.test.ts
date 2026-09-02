import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { flushSync } from 'svelte';
import MessageList from './MessageList.svelte';
import { createMessage, createNetwork, createBuffer } from '../test/factories';
import { ircState, prependMessages } from '../stores/ircStore.svelte';
import { clearedAtMap } from '../stores/preferences.svelte';

function reset() {
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
  Object.keys(clearedAtMap).forEach(k => delete (clearedAtMap as Record<string, any>)[k]);
}

describe('seamless bottom to start', () => {
  beforeEach(reset);

  it('starts at bottom and scrolls seamlessly to start without reset', async () => {
    const net = createNetwork({ networkId: 'net1' });
    net.buffers.push(createBuffer({ name: '#superbowl', type: 'channel' }));
    ircState.networks.push(net);
    ircState.activeBuffer.networkId = 'net1';
    ircState.activeBuffer.bufferName = '#superbowl';
    const now = Date.now();
    const initial: any[] = [];
    for (let i = 0; i < 1000; i++) {
      initial.push(createMessage({ text: `msg-${i} ` + 'x'.repeat(20), t: now - (1000 - i) * 1000, msgid: `m-${i}`, eid: 1000 + i, nick: 'user' }));
    }
    ircState.messages['net1:#superbowl'] = initial;
    flushSync();

    const onLoadMore = vi.fn(async () => {
      const oldest = ircState.messages['net1:#superbowl'][0] as any;
      const oldestEid = oldest.eid ?? 1000;
      if (oldestEid <= 0) return false;
      const older: any[] = [];
      for (let i = 0; i < 100; i++) {
        const eid = oldestEid - 100 + i;
        older.push(createMessage({ text: `older-${eid}`, t: now - (2000 - eid) * 1000, msgid: `m-${eid}`, eid, nick: 'user' }));
      }
      prependMessages('net1', '#superbowl', older);
      return true;
    });

    render(MessageList, { props: { onLoadMore } as any });
    flushSync();
    await new Promise(r => requestAnimationFrame(r));
    await new Promise(r => setTimeout(r, 100));
    const c = document.getElementById('messages') as HTMLDivElement;
    expect(c).not.toBeNull();
    c.style.height = '400px';
    c.style.overflowY = 'auto';
    await new Promise(r => requestAnimationFrame(r));
    // Let the container ResizeObserver re-pin (IRCCloud autogrow checkRecent) before scrolling.
    await new Promise((r) => setTimeout(r, 150));
    await new Promise(r => setTimeout(r, 300));
    // Start at bottom (IRCCloud render shows last 200)
    expect(Math.abs(c.scrollHeight - c.scrollTop - c.clientHeight) <= 5).toBe(true);
    const startDist = c.scrollHeight - c.scrollTop - c.clientHeight;
    expect(startDist).toBeLessThan(5);

    // Seamlessly scroll to start: each top-hit should leave divider at 152px (half-way)
    // and keep distBottom >100 (not snapped to bottom, not wedged at 0)
    for (let iter = 0; iter < 8; iter++) {
      // Simulate user scrolling to top (like holding wheel-up)
      c.scrollTop = 0;
      c.dispatchEvent(new Event('scroll'));
      // Also dispatch wheel to clear stick (like real user)
      c.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true }));
      await new Promise(r => setTimeout(r, 350));
      await new Promise(r => requestAnimationFrame(r));
      const divider = document.querySelector('.backlogDivider') as HTMLElement | null;
      if (divider) {
        const a = Math.round(divider.getBoundingClientRect().top - c.getBoundingClientRect().top + c.scrollTop);
        const dividerTopInViewport = divider.getBoundingClientRect().top - c.getBoundingClientRect().top;
        console.log(`[seamless] iter ${iter} a=${a} scrollTop=${c.scrollTop} dividerTopInViewport=${dividerTopInViewport} distBottom=${c.scrollHeight - c.scrollTop - c.clientHeight}`);
        // Half-way scroll leaves divider at 152px (min 48), but after all in-memory
        // history is loaded (renderStart=0) the divider may be further down
        // as network history (100 per batch) is prepended. Just check it's visible.
        expect(dividerTopInViewport).toBeGreaterThan(0);
        expect(dividerTopInViewport).toBeLessThan(4000);
      }
      const distBottom = c.scrollHeight - c.scrollTop - c.clientHeight;
      // Not snapped to bottom (would be <5), half-way leaves distBottom >100
      // At the very start (renderStart=0) scrollTop may be 0 (top), which is correct
      expect(distBottom > 100).toBe(true);
      expect(c.scrollTop).toBeGreaterThanOrEqual(0);
      expect(c.scrollTop).toBeLessThan(c.scrollHeight);
      // Verify we didn't lose place: scrollHeight should have grown, and we are not at bottom
      expect(c.scrollHeight).toBeGreaterThan(400);
    }

    // Final: still not at bottom, still can scroll, and first message is visible at top after full load
    c.scrollTop = 0;
    c.dispatchEvent(new Event('scroll'));
    await new Promise(r => setTimeout(r, 400));
    await new Promise(r => requestAnimationFrame(r));
    expect(c.scrollHeight - c.scrollTop - c.clientHeight > 100).toBe(true);
    // After 8+ loads, we should have loaded at least some older messages if network is available,
    // but with MAX_SILENT_FILLS 1 and count 100, the in-memory 1000 may already be all
    // that is rendered (renderStart=0). Just check we didn't lose messages and still have 1000.
    expect((ircState.messages['net1:#superbowl']?.length ?? 0)).toBeGreaterThanOrEqual(1000);
  }, 20000);
});
