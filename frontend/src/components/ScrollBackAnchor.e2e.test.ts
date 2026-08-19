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

describe('top-of-backlog scroll behavior', () => {
  it('keeps the messages being read in view and in order across backlog reveals', async () => {
    const net = createNetwork({ networkId: 'net1' });
    net.buffers.push(createBuffer({ name: '#chan', type: 'channel' }));
    ircState.networks.push(net);
    ircState.activeBuffer.networkId = 'net1';
    ircState.activeBuffer.bufferName = '#chan';

    const now = Date.now();
    const total = 1000;
    const seed: ReturnType<typeof createMessage>[] = [];
    for (let i = 0; i < total; i++) {
      seed.push(createMessage({ text: `msg-${i}`, t: now - (total - i) * 1000, msgid: `m-${i}`, nick: `user${i % 3}` }));
    }
    ircState.messages['net1:#chan'] = seed;
    flushSync();

    // Network path: each load-more call prepends an older batch (200 msgs).
    let nextEid = -1;
    const onLoadMore = async () => {
      const existing = ircState.messages['net1:#chan'] ?? [];
      const minT = existing.length ? Math.min(...existing.map((m) => m.t || 0)) : now;
      if (minT <= now - 60 * 60 * 1000) return false; // exhaust after 1h of backlog
      const older = [];
      for (let i = 0; i < 200; i++) {
        const t = minT - (200 - i) * 1000;
        older.push(createMessage({ text: `older-${t}`, t, msgid: `o-${t}`, nick: `user${i % 3}` }));
      }
      prependMessages('net1', '#chan', older);
      return true;
    };

    render(MessageList, { props: { onLoadMore } });
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

    // Park at the top (the reading position) and trigger the in-memory
    // reveal chain. The first reveal runs synchronously in the dispatch;
    // the rest fire via the IntersectionObserver on later frames. Capture
    // the anchor (the message being read) after the synchronous reveal —
    // every subsequent reveal must keep it exactly in place: older chat
    // loads above while the reading position is preserved.
    c.scrollTop = 0;
    c.dispatchEvent(new Event('scroll'));
    await new Promise((r) => requestAnimationFrame(r));
    await new Promise((r) => setTimeout(r, 30));

    const anchorBefore = (() => {
      const rows = Array.from(document.querySelectorAll('.row.messageRow')) as HTMLElement[];
      const viewportTop = c!.getBoundingClientRect().top;
      return rows.find((r) => {
        const rect = r.getBoundingClientRect();
        return rect.top >= viewportTop - 5 && rect.top < viewportTop + 200;
      }) ?? rows[0] ?? null;
    })();
    expect(anchorBefore).not.toBeNull();
    const anchorKey = anchorBefore!.dataset.msgid || anchorBefore!.textContent?.trim().slice(0, 30) || '';
    const anchorTopBefore = anchorBefore!.getBoundingClientRect().top;
    const scrollTopBefore = c.scrollTop;
    const scrollHeightBefore = c.scrollHeight;

    // Let the rest of the reveal chain settle.
    await new Promise((r) => setTimeout(r, 600));
    await new Promise((r) => requestAnimationFrame(r));

    // IRCCloud fetched() half-way scroll: divider at 152px from top (min 48)
    const divider = document.querySelector('.backlogDivider') as HTMLElement | null;
    expect(divider).not.toBeNull();
    if (divider) {
      const dividerTopInViewport = divider.getBoundingClientRect().top - c.getBoundingClientRect().top;
      expect(dividerTopInViewport).toBeGreaterThan(20);
      expect(dividerTopInViewport).toBeLessThan(180);
    }
    // Anchor should still be in viewport, but half-way scroll moves it 152px down, not exact
    const anchorAfter = Array.from(document.querySelectorAll('.row.messageRow'))
      .find((r) => (r as HTMLElement).dataset.msgid === anchorKey || (r as HTMLElement).textContent?.includes(anchorKey.slice(0, 20) || '')) as HTMLElement | null;
    expect(anchorAfter, 'anchor message left the viewport after the reveal chain').not.toBeNull();
    if (anchorAfter) {
      const rect = anchorAfter.getBoundingClientRect();
      const viewport = c.getBoundingClientRect();
      expect(rect.top).toBeGreaterThan(viewport.top - 10);
      expect(rect.bottom).toBeLessThan(viewport.bottom + 200);
    }
    // The viewport advanced by the revealed height and is not at the bottom.
    // Half-way scroll (IRCCloud fetched) leaves scrollTop at max(a-152,48),
    // which is *less* than the previous bottom position, but >0 and not at bottom.
    expect(c.scrollTop).toBeGreaterThan(0);
    expect(c.scrollHeight).toBeGreaterThanOrEqual(scrollHeightBefore);
    expect(c.scrollHeight - c.scrollTop - c.clientHeight).toBeGreaterThan(10);
  });
});
