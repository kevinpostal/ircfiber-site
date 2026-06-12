<script lang="ts">
  import { untrack, flushSync } from 'svelte';
  import { ircState, isMessageUnseen, getLastSeenMessage, countMessagesBetween, countImportantMessagesBetween, clearUnseenHighlightsAfter, unseenHighlightCountAfter, updateBottomSeen, setBacklogDivider } from '../stores/ircStore.svelte';
  import { getClearedAt, setLastSeen } from '../stores/preferences.svelte';
  import { preprocessMessages } from '../lib/messageBuilder';
  import MessageRow from './MessageRow.svelte';
  import DateChange from './DateChange.svelte';

  import SeenDivider from './SeenDivider.svelte';
  import LoadMore from './LoadMore.svelte';
  import ChatterBar from './ChatterBar.svelte';
  import ScrollClock from './ScrollClock.svelte';
  import { isSkippedCommand, getMsgDate, formatDate, formatDateTimeTitle, formatShortRelativeTime, stringHash, stripPrefix } from '../lib/utils';
  import type { IRCMessage } from '../types';

  interface Props {
    onNickClick?: (nick: string, event: MouseEvent, member?: any | null) => void;
    onLoadMore?: () => Promise<boolean>;
  }
  let { onNickClick, onLoadMore }: Props = $props();

  let container = $state(null) as HTMLDivElement | null;

  // ── IRCCloud scroll state (matches BufferScrollView) ──
  // Cached: only re-read from DOM on real (non-programmatic) scroll events.
  // This prevents the stale-read race where we snap to bottom because the
  // browser hasn't fired the scroll event yet when a new message arrives.
  let cachedAtBottom = true;
  let wasRecentlyAtBottom = true;
  let recentlyScrolledTimeout: ReturnType<typeof setTimeout> | null = null;

  let aboveUnseenCount = $state(0);
  let belowUnseenCount = $state(0);
  let aboveUnseenTimestamp = $state<number | null>(null);
  let belowUnseenTimestamp = $state<number | null>(null);
  let aboveUnseenHighlights = $state(0);
  let belowUnseenHighlights = $state(0);

  let stickyNick = $state('');
  let stickyColor = $state('');
  let stickyMode = $state('');
  // Direct DOM ref to the sticky avatar container — IRCCloud does
  // `this.stickyAvatarContainer.css({ top: top })` (jQuery, synchronous,
  // no framework reactivity). We mirror that with a direct style write
  // here so the `top` updates on every scroll event feel just as snappy
  // and aren't queued behind a Svelte microtask.
  let stickyAvatarEl: HTMLDivElement | null = null;
  let batchRendering = false;
  // IRCCloud-style: capture pinBottom BEFORE each reactive flush runs.
  // Without this, cachedAtBottom can be stale by the time the $effect
  // fires, causing an unnecessary scrollToBottom.
  let pinBottomBeforeFlush = false;

  // IRCCloud ScrollClockView: timestamp of the message at the top of the
  // scroll; null hides the clock (at bottom / no upper message).
  let clockTs = $state<number | null>(null);

  const bufferKey = $derived(`${ircState.activeBuffer.networkId}:${ircState.activeBuffer.bufferName}`);

  const processedMessages = $derived.by(() => {
    const key = bufferKey;
    const raw = ircState.messages[key] ?? [];
    const clearedAt = ircState.activeBuffer.networkId && ircState.activeBuffer.bufferName
      ? getClearedAt(ircState.activeBuffer.networkId, ircState.activeBuffer.bufferName) : null;
    const cleared = clearedAt ? raw.filter(m => (m.t || 0) > clearedAt) : raw;
    const noEmpty = cleared.filter(m => {
      if (m.lines || m.sentences || m.events) return true;
      return typeof m.text === 'string' && m.text.trim() !== '';
    });
    return preprocessMessages(noEmpty);
  });

  function checkSameAuthor(msg: IRCMessage, prev: IRCMessage | null): boolean {
    if (!prev) return false;
    if (msg.command !== 'PRIVMSG' && msg.type !== 'action') return false;
    if (prev.command !== 'PRIVMSG' && prev.type !== 'action') return false;
    const nick = stripPrefix(msg.nick || '');
    const prevNick = stripPrefix(prev.nick || '');
    if (!nick || !prevNick || nick !== prevNick) return false;
    return true;
  }

  function shouldShowSeenDivider(msg: IRCMessage, prev: IRCMessage | null): boolean {
    if (!ircState.lastSeenMsgTime || !ircState.focusLost) return false;
    if (!prev) return false;
    return (prev.t || 0) <= ircState.lastSeenMsgTime && (msg.t || 0) > ircState.lastSeenMsgTime;
  }

  // IRCCloud backlogDivider: marks the old/new boundary after a backlog
  // fetch. Renders above the message that was earliest before the fetch.
  // Marks are `<seq>|<itemKey>` (seq guarantees uniqueness per fetch);
  // bare keys are accepted too for compatibility.
  const backlogDividerMark = $derived(ircState.backlogDivider[bufferKey] ?? '');
  const backlogDividerKey = $derived.by(() => {
    const mark = backlogDividerMark;
    const sep = mark.indexOf('|');
    return sep >= 0 ? mark.slice(sep + 1) : mark;
  });

  // ── DOM windowing (IRCCloud BufferScrollView/BufferLogView) ──
  // IRCCloud never renders the whole buffer:
  //   - buffer open renders the last batchSize=200 messages
  //     (BufferLogView.render → messages.last(batchSize))
  //   - scroll-to-top reveals the previous 200 from memory instantly
  //     (loadOrRenderBacklog → messages.filterBeforeEid(first, batchSize));
  //     the network is only hit when memory is fully rendered
  //   - while pinned at the bottom, the DOM is trimmed back to 200 rows
  //     once more than 350 are rendered (checkTrim, trimDetectThreshold=350,
  //     trimThreshold=200)
  // The bounded DOM is a big part of why IRCCloud scrolling stays smooth.
  const BATCH_SIZE = 200;
  const TRIM_DETECT_THRESHOLD = 350;
  const TRIM_THRESHOLD = 200;
  let renderStart = $state(0);

  // IRCCloud BufferLogView.bufferMessage/checkFlush: while the user is
  // scrolled up reading, incoming messages are buffered and the DOM is NOT
  // touched — they flush when the user returns to the bottom. We freeze the
  // window's end at the last rendered message when leaving the bottom, so
  // realtime traffic causes zero layout work during a reading session.
  let renderEndKey = $state('');

  function itemKeyOf(msg: IRCMessage): string {
    if (msg.eid != null) return `e:${msg.eid}`;
    return msg.msgid || `t:${msg.t}`;
  }

  // Backstop against duplicate keys reaching the {#each}. The store is
  // supposed to dedup by eid/msgid before messages land here, but if a
  // message slips through with no eid AND no msgid AND the same `t` as
  // another message, the bare `t:${t}` key would collide. The tiebreaker
  // suffix below is unique within a single render, which is all Svelte's
  // keyed each needs.
  function stableKey(msg: IRCMessage, positionInRender: number): string {
    const base = itemKeyOf(msg);
    // Always suffix the position so identical base keys within one
    // render are impossible. Stable across renders because position
    // within the rendered window is what Svelte uses for ordering
    // anyway, and the eid/msgid prefix still lets it detect moves.
    return `${base}#${positionInRender}`;
  }

  const processedIndexByKey = $derived.by(() => {
    const m = new Map<string, number>();
    processedMessages.forEach((msg, i) => {
      const k = itemKeyOf(msg);
      if (!m.has(k)) m.set(k, i);
    });
    return m;
  });

  // IRCCloud BufferLogView.checkTrim — only while scrolled to the bottom.
  function maybeTrim(): void {
    const len = processedMessages.length;
    const start = untrack(() => renderStart);
    if (len - start > TRIM_DETECT_THRESHOLD) {
      renderStart = len - TRIM_THRESHOLD;
    }
  }

  // IRCCloud loadOrRenderBacklog (in-memory path): reveal the previous
  // batch instantly with the backlogDivider + divider scroll. IRCCloud
  // renders AND scrolls synchronously inside the same scroll event —
  // crucial, because if the user is left parked at scrollTop 0 the browser
  // fires no further scroll events on wheel-up and infiniscroll wedges
  // until they scroll down and back up. Returns false when everything in
  // memory is already rendered (caller falls through to the network).
  function revealBacklogFromMemory(): boolean {
    const start = untrack(() => renderStart);
    if (start <= 0 || !container) return false;

    // Live position reads (IRCCloud fetched() captures these before render;
    // the cached values can be stale when invoked from the loadMore click,
    // which scrolls to the top in the same tick).
    const atTop = container.scrollTop <= 0;
    const scrollBottom = container.clientHeight + Math.ceil(container.scrollTop);
    const pinBottom = container.scrollHeight - scrollBottom <= 1;

    const boundary = processedMessages[start];
    if (boundary && ircState.activeBuffer.networkId && ircState.activeBuffer.bufferName) {
      setBacklogDivider(ircState.activeBuffer.networkId, ircState.activeBuffer.bufferName, itemKeyOf(boundary));
    }
    renderStart = Math.max(0, start - BATCH_SIZE);
    // Consume the mark so the $effect doesn't run the settle a second time.
    handledDividerMark = untrack(() => backlogDividerMark);

    // Render synchronously, then settle — no rAF gap for queued wheel
    // events to fire a second reveal from scrollTop 0.
    flushSync();
    if (atTop && !pinBottom) {
      const divider = container.querySelector('.backlogDivider') as HTMLElement | null;
      if (divider) {
        const pos = dividerPos(divider);
        container.scrollTop = pos - 31;
        animateScrollTo(Math.max(pos - 152, 48), () => {
          if (!container) return;
          // Recalculate top and scroll to it again, might have moved
          const pos2 = dividerPos(divider);
          container.scrollTop = Math.max(pos2 - 152, 48);
        });
      } else {
        // Guard: never strand the user at scrollTop 0 (no scroll events
        // fire at the boundary, so the next chunk could never trigger).
        container.scrollTop = 48;
      }
    }
    return true;
  }

  // Pre-compute date separators over the rendered window
  const messagesWithDates = $derived.by(() => {
    const all = processedMessages;
    const start = Math.max(0, Math.min(renderStart, all.length));
    let end = all.length;
    if (renderEndKey) {
      const endIdx = processedIndexByKey.get(renderEndKey);
      if (endIdx !== undefined && endIdx >= start) end = endIdx + 1;
    }
    const msgs = start > 0 || end < all.length ? all.slice(start, end) : all;
    const dividerMark = backlogDividerKey;
    let lastDate = '';
    // IRCCloud only ever renders ONE backlogDivider (removeBacklogDivider
    // runs before each new render). The timestamp fallback can match
    // several messages that share the boundary's `t`, so place the
    // divider on the first match only.
    let dividerPlaced = false;
    return msgs.map((msg, i) => {
      const msgDate = getMsgDate(msg);
      const prevMsg = i > 0 ? msgs[i - 1] : null;
      const prevDate = prevMsg ? getMsgDate(prevMsg) : null;
      const showDate = !!(msgDate && msgDate !== prevDate && msgDate !== lastDate);
      if (showDate) lastDate = msgDate;
      const showBacklogDivider = !dividerPlaced && dividerMark !== '' && i > 0 &&
        (msg.msgid ? msg.msgid === dividerMark : `t:${msg.t}` === dividerMark);
      if (showBacklogDivider) dividerPlaced = true;
      return { msg, showDate, msgDate, prevDate, prevMsg, showBacklogDivider, _key: stableKey(msg, i) };
    });
  });

  // O(1) lookup maps for the scroll-position helpers — rebuilt only when
  // messages change, never during scroll events.
  const renderedIndexByKey = $derived.by(() => {
    const m = new Map<string, number>();
    messagesWithDates.forEach((item, i) => {
      const k = itemKeyOf(item.msg);
      if (!m.has(k)) m.set(k, i);
    });
    return m;
  });

  const rawMessageByKey = $derived.by(() => {
    const m = new Map<string, IRCMessage>();
    for (const msg of ircState.messages[bufferKey] ?? []) {
      const k = itemKeyOf(msg);
      if (!m.has(k)) m.set(k, msg);
    }
    return m;
  });

  // Member-by-nick Map for O(1) lookup in MessageRow.  Rebuilt when the
  // buffer user list changes (which is much less frequent than messages).
  const memberByNick = $derived.by(() => {
    const m = new Map<string, Member>();
    try {
      const buf = getActiveBufferObj();
      if (buf?.users) {
        for (const u of buf.users) {
          m.set(stripPrefix(u.nick), u);
        }
      }
    } catch {}
    return m;
  });

  // ── Scroll position maintenance (matches IRCCloud) ──
  // IRCCloud's fetched() flow (BufferScrollView.fetched):
  //   - captures atTop + pinBottom BEFORE render
  //   - renders fetched messages + backlogDivider at the boundary
  //   - if pinBottom → scrollToBottom
  //   - if atTop && divider → snap to (dividerPos - 31), animate 100ms to
  //     max(dividerPos - 152, 48), then recalc divider pos and snap again
  //   - if neither → DO NOTHING (browser scroll anchoring keeps position)
  // Landing at ≥48px pulls the user off scrollTop=0, so the next batch
  // needs another deliberate scroll to the very top — that's IRCCloud's
  // chunk-by-chunk paging feel.

  // Track "at top" like we track "at bottom" — captured in handleScroll,
  // used in $effect to decide if we should run the divider scroll after
  // a backlog prepend.
  let cachedAtTop = false;

  let lastBufferKey = '';
  let prevScrollHeight = 0;
  let prevScrollTop = 0;
  let handledDividerMark = '';

  // IRCCloud BufferScrollView.scrollTo({animate: true}): jQuery animate
  // with default 100ms-ish duration and "swing" easing.
  function animateScrollTo(target: number, afterAnimate?: () => void): void {
    if (!container) return;
    const start = container.scrollTop;
    const startTime = performance.now();
    const duration = 100;
    function step(now: number): void {
      if (!container) return;
      const t = Math.min((now - startTime) / duration, 1);
      const eased = 0.5 - Math.cos(Math.PI * t) / 2; // jQuery "swing"
      container.scrollTop = start + (target - start) * eased;
      if (t < 1) requestAnimationFrame(step);
      else afterAnimate?.();
    }
    requestAnimationFrame(step);
  }

  // Divider position in scroll-content coordinates (jQuery .position().top
  // equivalent for the scroll container).
  function dividerPos(divider: HTMLElement): number {
    if (!container) return 0;
    return Math.round(
      divider.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop
    );
  }

  let lastFirstProcessedKey = '';

  $effect(() => {
    const key = bufferKey;
    const msgs = processedMessages;
    if (key !== lastBufferKey) {
      lastBufferKey = key;
      cachedAtBottom = true;
      wasRecentlyAtBottom = true;
      cachedAtTop = false;
      prevScrollHeight = 0;
      handledDividerMark = '';
      // IRCCloud BufferLogView.render: open with the last batchSize=200.
      renderStart = Math.max(0, msgs.length - BATCH_SIZE);
      renderEndKey = '';
      clockTs = null;
      lastFirstProcessedKey = msgs.length ? itemKeyOf(msgs[0]) : '';
    } else {
      const firstKey = msgs.length ? itemKeyOf(msgs[0]) : '';
      if (firstKey !== lastFirstProcessedKey) {
        const start = untrack(() => renderStart);
        if (lastFirstProcessedKey === '') {
          // Buffer content arrived (initial history load): window the tail.
          renderStart = Math.max(0, msgs.length - BATCH_SIZE);
        } else if (start > 0) {
          // Messages were PREPENDED (network backlog / WS CHATHISTORY
          // backfill) while the window starts mid-buffer: shift the window
          // so the rendered rows stay identical.
          const idx = msgs.findIndex(m => itemKeyOf(m) === lastFirstProcessedKey);
          if (idx > 0) renderStart = start + idx;
          else if (idx < 0) renderStart = Math.max(0, msgs.length - BATCH_SIZE);
        }
        lastFirstProcessedKey = firstKey;
      }
    }

    if (!container) return;

    const mark = backlogDividerMark;
    const newDivider = mark !== '' && mark !== handledDividerMark;
    handledDividerMark = mark;

    if (cachedAtBottom) {
      // IRCCloud checkFlush → checkTrim: bound the DOM while pinned.
      maybeTrim();
      // IRCCloud scrollToBottom: only scroll if we're not already at the
      // bottom.  Re-reading the DOM here is the same pattern as IRCCloud's
      // isScrolledToBottom(true) inside scrollToBottom — checking the live
      // position, not the cached value, so we never scroll unnecessarily
      // when the content grew but the user is already at the end.
      const scrollHeight = container.scrollHeight;
      const offsetHeight = container.clientHeight;
      const scrollPos = Math.ceil(container.scrollTop);
      const bottom = (scrollHeight - offsetHeight) + 1;
      const atBottom = (bottom - scrollPos) <= 1;
      if (!atBottom) {
        // Snap to bottom. We're inside a $effect, so the DOM has already
        // been updated by Svelte — no need to wait for an rAF. The browser
        // applies the scroll on the next paint, which is what we want
        // (we want a single paint, not a 16ms gap). For huge batches
        // (50+ new messages) the rAF was adding a frame of latency that
        // made the chat feel like it "wasn't keeping up" with rapid input.
        container.scrollTop = scrollHeight;
        cachedAtTop = false;
      }
    } else if (newDivider && cachedAtTop) {
      // IRCCloud fetched(): atTop && !pinBottom && divider → divider scroll.
      requestAnimationFrame(() => {
        if (!container) return;
        const divider = container.querySelector('.backlogDivider') as HTMLElement | null;
        if (!divider) {
          // Guard: never strand the user at scrollTop 0 — no scroll events
          // fire at the boundary, so the next batch could never trigger.
          if (container.scrollTop <= 0) container.scrollTop = 48;
          return;
        }
        const pos = dividerPos(divider);
        container.scrollTop = pos - 31;
        animateScrollTo(Math.max(pos - 152, 48), () => {
          if (!container) return;
          // Recalculate top and scroll to it again, might have moved
          const pos2 = dividerPos(divider);
          container.scrollTop = Math.max(pos2 - 152, 48);
        });
      });
    }
    // else: browser handles position (IRCCloud: fetchDone(true, pinBottom) → no scroll)
  });

  // ── IRCCloud match: BufferScrollView.setScrolledToBottom(value)
  // Updates the cached scroll position and manages the 100ms grace period.
  function handleScroll(): void {
    if (!container) return;
    // IRCCloud batchRendering: ignore scroll events that fire during a
    // batch flush (DOM reflow from batch append can trigger them).
    if (batchRendering) return;

    // IRCCloud deduplication: ignore scroll events where nothing actually
    // changed (prevents double-fires from our own programmatic scrolls).
    const scrollTop = container.scrollTop;
    const scrollHeight = container.scrollHeight;
    if (prevScrollTop === scrollTop && prevScrollHeight === scrollHeight) return;
    prevScrollTop = scrollTop;
    prevScrollHeight = scrollHeight;

    // IRCCloud isScrolledToTop(): user is at the very top of the container.
    cachedAtTop = scrollTop <= 0;

    // IRCCloud isScrolledToBottom(true): 1px slop for zoomed browsers.
    const scrollBottom = container.clientHeight + Math.ceil(scrollTop);
    const atBottom = scrollHeight - scrollBottom <= 1;

    // IRCCloud setScrolledToBottom: only act when the value CHANGES.
    if (cachedAtBottom === atBottom) {
      // Still at bottom or still not at bottom — just update auxiliary state
      updateScrollState();
    } else {
      cachedAtBottom = atBottom;

      if (atBottom) {
        // Just arrived at bottom
        wasRecentlyAtBottom = true;
        if (recentlyScrolledTimeout) {
          clearTimeout(recentlyScrolledTimeout);
          recentlyScrolledTimeout = null;
        }
        // IRCCloud checkFlush: returning to the bottom flushes buffered
        // messages and trims the DOM back to 200 rows.
        renderEndKey = '';
        maybeTrim();
      } else {
        // Just left bottom — 100ms grace period for autogrow-input only
        if (recentlyScrolledTimeout) clearTimeout(recentlyScrolledTimeout);
        recentlyScrolledTimeout = setTimeout(() => {
          wasRecentlyAtBottom = false;
          recentlyScrolledTimeout = null;
        }, 100);
        // IRCCloud bufferMessage: while scrolled up, new messages buffer
        // instead of rendering — freeze the window's end where it is now.
        const all = processedMessages;
        renderEndKey = all.length ? itemKeyOf(all[all.length - 1]) : '';
      }

      updateScrollState();
    }

    // IRCCloud BufferScrollView.checkInfiniscroll → loadOrRenderBacklog:
    // when the user reaches the top of the scroll, reveal the previous
    // batch from memory.  This is what powers IRCCloud's chunk-by-chunk
    // infinite scroll — without it, scrolling to the top of a long
    // buffer would park the user at scrollTop 0 where the browser fires
    // no further scroll events on wheel-up, wedging the infinite scroll.
    if (cachedAtTop && !cachedAtBottom) {
      revealBacklogFromMemory();
    }
  }

  // ── Row-at-point lookups (IRCCloud BufferLogContainerView.getRowAtPosition) ──
  // IRCCloud resolves the rows at the top/bottom of the viewport with an
  // elementFromPoint hit test — O(1) per scroll event. Iterating every row
  // with getBoundingClientRect forces O(n) layout reads per scroll tick,
  // which is the main source of scroll jank on long backlogs.
  function rowFromPoint(x: number, y: number): HTMLElement | null {
    for (const el of document.elementsFromPoint(x, y)) {
      const row = (el as HTMLElement).closest?.('.row.messageRow') as HTMLElement | null;
      if (row && container?.contains(row)) return row;
    }
    return null;
  }

  function probeRow(rect: DOMRect, from: 'top' | 'bottom'): HTMLElement | null {
    const x = rect.left + 24;
    // Probe a few offsets to step over date dividers / seen markers that
    // sit between message rows.
    for (const dy of [2, 16, 34, 58]) {
      const y = from === 'top' ? rect.top + dy : rect.bottom - dy;
      if (y <= rect.top || y >= rect.bottom) continue;
      const row = rowFromPoint(x, y);
      if (row) return row;
    }
    return null;
  }

  function rowKeyOf(row: HTMLElement): string {
    return row.dataset.msgid || `t:${row.dataset.time}`;
  }

  function updateScrollState(): void {
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const topRow = probeRow(rect, 'top');
    const bottomRow = probeRow(rect, 'bottom');
    updateChatterCounts(topRow, bottomRow);
    updateReadTracking(rect, bottomRow);
    updateStickyAvatar(topRow, rect);
    updateScrollClock(topRow);
  }

  // IRCCloud BufferScrollView.updateClock / ScrollClockView.update:
  // show the clock with the upper message's time while scrolled up.
  function updateScrollClock(topRow: HTMLElement | null): void {
    if (cachedAtBottom || !topRow) {
      clockTs = null;
      return;
    }
    const t = parseInt(topRow.dataset.time || '', 10);
    clockTs = Number.isFinite(t) ? t : null;
  }

  function updateChatterCounts(topRow: HTMLElement | null, bottomRow: HTMLElement | null): void {
    const { networkId, bufferName } = ircState.activeBuffer;
    if (!networkId || !bufferName) return;
    const rendered = messagesWithDates;

    const topIdx = topRow ? (renderedIndexByKey.get(rowKeyOf(topRow)) ?? -1) : -1;
    const bottomIdx = bottomRow ? (renderedIndexByKey.get(rowKeyOf(bottomRow)) ?? -1) : -1;

    // The top/bottom probed rows are partially visible; everything before/
    // after them in the rendered window is fully out of the viewport.
    let above = 0;
    let aboveTs: number | null = null;
    let firstAboveMsg: IRCMessage | null = null;
    if (topIdx > 0) {
      above = topIdx;
      const item = rendered[0];
      firstAboveMsg = rawMessageByKey.get(itemKeyOf(item.msg)) ?? null;
      aboveTs = item.msg.t || null;
    }

    let below = 0;
    let belowTs: number | null = null;
    let firstBelowMsg: IRCMessage | null = null;
    if (bottomIdx >= 0 && bottomIdx < rendered.length - 1) {
      below = rendered.length - 1 - bottomIdx;
      const item = rendered[bottomIdx + 1];
      firstBelowMsg = rawMessageByKey.get(itemKeyOf(item.msg)) ?? null;
      belowTs = item.msg.t || null;
    } else if (bottomIdx >= 0) {
      // The bottom row is the last rendered one, but messages may be
      // buffered beyond the frozen window end (IRCCloud messageBuffer) —
      // count those so the "new messages below" bar still appears.
      const all = processedMessages;
      const endIdx = Math.max(0, Math.min(renderStart, all.length)) + rendered.length;
      if (endIdx < all.length) {
        below = all.length - endIdx;
        const tail = all[endIdx];
        firstBelowMsg = rawMessageByKey.get(itemKeyOf(tail)) ?? null;
        belowTs = tail.t || null;
      }
    }

    const lastSeenMsg = getLastSeenMessage(networkId, bufferName);
    if (firstAboveMsg && isMessageUnseen(firstAboveMsg, networkId, bufferName) && lastSeenMsg) {
      const totalBetween = countMessagesBetween(networkId, bufferName, lastSeenMsg, firstAboveMsg);
      if (totalBetween > 100) {
        aboveUnseenCount = totalBetween;
        aboveUnseenTimestamp = lastSeenMsg.t || null;
      } else {
        const important = countImportantMessagesBetween(networkId, bufferName, lastSeenMsg, firstAboveMsg);
        aboveUnseenCount = important > 0 ? important : totalBetween;
        aboveUnseenTimestamp = lastSeenMsg.t || null;
      }
      aboveUnseenHighlights = clearUnseenHighlightsAfter(networkId, bufferName, firstAboveMsg);
    } else {
      aboveUnseenCount = 0;
      aboveUnseenTimestamp = null;
      aboveUnseenHighlights = 0;
    }

    const bottomSeenMsg = firstBelowMsg;
    if (bottomSeenMsg) {
      updateBottomSeen(networkId, bufferName, bottomSeenMsg);
      const totalBelow = countMessagesBetween(networkId, bufferName, bottomSeenMsg);
      if (totalBelow > 100) {
        belowUnseenCount = totalBelow;
        belowUnseenTimestamp = bottomSeenMsg.t || null;
      } else {
        const important = countImportantMessagesBetween(networkId, bufferName, bottomSeenMsg);
        belowUnseenCount = important > 0 ? important : totalBelow;
        belowUnseenTimestamp = bottomSeenMsg.t || null;
      }
      belowUnseenHighlights = unseenHighlightCountAfter(networkId, bufferName, bottomSeenMsg);
    } else {
      belowUnseenCount = below;
      belowUnseenTimestamp = belowTs;
      belowUnseenHighlights = 0;
    }
  }

  function updateReadTracking(rect: DOMRect, bottomRow: HTMLElement | null): void {
    const { networkId, bufferName } = ircState.activeBuffer;
    if (!networkId || !bufferName || !bottomRow) return;
    const rendered = messagesWithDates;
    let idx = renderedIndexByKey.get(rowKeyOf(bottomRow)) ?? -1;
    if (idx < 0) return;
    // Last FULLY visible row: if the bottom row is cut off, step back one
    // (IRCCloud getRowAtBottomOfScroll half-height rule).
    const rowRect = bottomRow.getBoundingClientRect();
    if (rowRect.bottom > rect.bottom + 1) idx -= 1;
    const item = rendered[idx];
    if (!item) return;
    const raw = rawMessageByKey.get(itemKeyOf(item.msg));
    if (raw?.t) {
      setLastSeen(networkId, bufferName, raw.t);
    }
  }

  function updateStickyAvatar(topRow: HTMLElement | null, rect: DOMRect): void {
    if (!container) return;
    // IRCCloud setStickyAuthor logic (bufferlogcontainerview.js):
    // Show the sticky avatar whenever the author of the visible messages
    // is hard to identify — typically when a long sameAuthor group has
    // pushed the firstAuthor row out of view.  Hide it when:
    //   1. The top row is not a message row (date divider, etc.).
    //   2. The firstAuthor's avatar is fully visible or below the scroll
    //      top (avatarTop >= scrollTop).
    //   3. The bottom of the author group is scrolled far enough that the
    //      avatar area (40px block) is fully visible (lastTop <= avatarTop).
    //
    // When at the bottom, we still show the sticky avatar for the LAST
    // visible message group.  If the latest messages are grouped (e.g.
    // 200 messages from the same user), the first message of the group
    // may be scrolled out of view even at the bottom, so the user
    // loses sight of whose messages they're reading.

    let firstAuthorEl: HTMLElement | null = null;
    let lastAuthorEl: HTMLElement | null = null;
    let showSticky = false;

    if (cachedAtBottom) {
      // At the bottom: find the bottommost message row visible in the
      // viewport and walk up to its firstAuthor.  We need the LAST
      // message group (most recent) so the user sees whose messages
      // they're reading right now.
      const scrollBottom = rect.top + container.clientHeight;
      const allRows = container.querySelectorAll('.messageRow');
      let bottomRow: HTMLElement | null = null;
      for (const row of Array.from(allRows)) {
        const r = row.getBoundingClientRect();
        if (r.top <= scrollBottom - 1) {
          bottomRow = row as HTMLElement;
        } else {
          break;
        }
      }
      if (!bottomRow) return;
      let groupStart: HTMLElement | null = bottomRow;
      while (groupStart && !groupStart.classList.contains('firstAuthor')) {
        groupStart = groupStart.previousElementSibling as HTMLElement | null;
      }
      if (!groupStart || !container.contains(groupStart)) {
        stickyNick = '';
        return;
      }
      // If the firstAuthor of this group is visible at the top of the
      // viewport (its avatar IS in view at the top of the group), we
      // don't need a sticky avatar — the name is already inline.
      const groupRect = groupStart.getBoundingClientRect();
      const avatarTopY = groupRect.top + 8;
      if (avatarTopY >= rect.top) {
        // firstAuthor is at or below the container top — its avatar is
        // already visible.  No sticky needed.
        stickyNick = '';
        return;
      }
      firstAuthorEl = groupStart;
      // Find the last sameAuthor in this group (most recent message)
      lastAuthorEl = groupStart;
      let sibling = groupStart.nextElementSibling as HTMLElement | null;
      while (sibling && sibling.classList.contains('sameAuthor')) {
        lastAuthorEl = sibling;
        sibling = sibling.nextElementSibling as HTMLElement | null;
      }
      showSticky = true;
    } else {
      // Scrolled up: use the topRow (current IRCCloud behavior).
      const actualTop = topRow;
      if (!actualTop) return;
      if (!actualTop.classList.contains('sameAuthor') && !actualTop.classList.contains('firstAuthor')) {
        return;
      }
      if (actualTop.classList.contains('sameAuthor')) {
        firstAuthorEl = actualTop;
        while (firstAuthorEl && !firstAuthorEl.classList.contains('firstAuthor')) {
          firstAuthorEl = firstAuthorEl.previousElementSibling as HTMLElement | null;
        }
      } else {
        firstAuthorEl = actualTop;
      }
      if (!firstAuthorEl || !container.contains(firstAuthorEl)) {
        stickyNick = '';
        return;
      }

      // IRCCloud: keep these synced with CSS
      const avatarHeight = 32;
      const avatarOffset = 8;
      const avatarBottom = avatarHeight + avatarOffset; // 40

      const firstAuthorRect = firstAuthorEl.getBoundingClientRect();
      const avatarTopY = firstAuthorRect.top + avatarOffset;
      const scrollTop = rect.top;

      if (avatarTopY >= scrollTop) {
        // Avatar is fully visible or below the scroll top — no sticky needed
        stickyNick = '';
        return;
      }

      // Find the last sameAuthor in this group
      lastAuthorEl = firstAuthorEl;
      let sibling = firstAuthorEl.nextElementSibling as HTMLElement | null;
      while (sibling && sibling.classList.contains('sameAuthor')) {
        lastAuthorEl = sibling;
        sibling = sibling.nextElementSibling as HTMLElement | null;
      }

      const lastAuthorRect = lastAuthorEl.getBoundingClientRect();
      const lastTop = lastAuthorRect.bottom - avatarBottom;

      if (lastTop <= avatarTopY) {
        // Avatar area is visible enough at the bottom — no sticky needed
        stickyNick = '';
        return;
      }
      showSticky = true;
    }

    if (!showSticky || !firstAuthorEl) return;

    const nick = firstAuthorEl.dataset.name || '';
    if (!nick) {
      stickyNick = '';
      return;
    }

    // Calculate the position for the sticky avatar at the top of the
    // viewport.  IRCCloud positions the sticky at the same y as the
    // firstAuthor's avatar so when the firstAuthor scrolls into view,
    // the two overlap seamlessly and the user can't tell the difference
    // — no pop, no blink, just the sticky sliding into the real avatar.
    // IRCCloud derives this from `lastTop` (lastSameAuthor.bottom - 40)
    // clamped to offsets.y, which converges to the firstAuthor avatar
    // position as the group shrinks.  We use the firstAuthor avatar
    // position directly to get the same seamless transition without
    // depending on the group's tail.
    //
    // The floor is 37 (DateChange ~29px + 8px avatar offset) so the
    // sticky avatar never sits behind a DateChange divider that might
    // be at the top of the viewport.
    const firstAuthorRect = firstAuthorEl.getBoundingClientRect();
    const avatarYInContainer = firstAuthorRect.top + 8 - rect.top;
    const offsetsY = 37;
    const top = Math.max(0, Math.min(avatarYInContainer, offsetsY));

    stickyNick = nick;
    stickyColor = `c${stringHash(nick) % 27}`;
    stickyMode = '';
    // IRCCloud `this.stickyAvatarContainer.css({ top: top })` — direct
    // synchronous DOM write.  Mirrors that exactly so the avatar feels
    // pinned to the scroll and the update lands in the same frame as
    // the scroll event, not on a later Svelte microtask.
    if (stickyAvatarEl) stickyAvatarEl.style.top = `${top}px`;
  }

  function scrollToTop(): void {
    container?.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function scrollToBottom(): void {
    if (container) container.scrollTo({ top: container.scrollHeight, behavior: 'smooth' });
  }
</script>

{#if aboveUnseenCount > 0}
  <ChatterBar position="above" count={aboveUnseenCount} timestamp={aboveUnseenTimestamp} mentions={aboveUnseenHighlights} onClick={scrollToTop} />
{/if}

<div class="messages-viewport" class:clockShown={clockTs !== null}>
  <div class="messages" id="messages" bind:this={container} onscroll={handleScroll}>
    <LoadMore {onLoadMore} onRevealFromMemory={revealBacklogFromMemory} />

    {#each messagesWithDates as item (item._key)}
      {@const msg = item.msg}
      {@const msgDate = item.msgDate}
      {@const prevDate = item.prevDate}
      {@const prevMsg = item.prevMsg}

      {#if item.showDate}
        <DateChange date={msgDate} />
      {/if}

      {#if item.showBacklogDivider}
        <div class="row backlogDivider"><hr /></div>
      {/if}

      {#if shouldShowSeenDivider(msg, prevMsg)}
        <SeenDivider />
      {/if}

      {#if !isSkippedCommand(msg.command)}
        <MessageRow
          {msg}
          isHighlight={msg.highlight ?? false}
          isSameAuthor={checkSameAuthor(msg, prevMsg)}
          {onNickClick}
          {memberByNick}
        />
      {/if}
    {/each}
  </div>

  {#if stickyNick}
    <div class="stickyAvatar authorWrap" role="presentation" aria-hidden="true" bind:this={stickyAvatarEl}>
      <span class="avatar letterAvatar {stickyColor}">
        <span role="presentation">{stickyNick.charAt(0).toUpperCase()}</span>
      </span>
    </div>
  {/if}

  <ScrollClock ts={clockTs} />
</div>

{#if belowUnseenCount > 0}
  <ChatterBar position="below" count={belowUnseenCount} timestamp={belowUnseenTimestamp} mentions={belowUnseenHighlights} onClick={scrollToBottom} />
{/if}

<style>
  .messages-viewport {
    position: relative;
  }
  .messages {
    overflow-y: auto;
    overflow-x: hidden;
    flex: 1;
  }
  /* IRCCloud .clockShown: pad the top rows so the floating scroll clock
     doesn't cover the loadMore button / fetching divider. */
  .messages-viewport.clockShown .messages :global(.row.loadMore),
  .messages-viewport.clockShown .messages :global(.row.fetch) {
    padding-top: 30px;
  }
  /* IRCCloud backlogDivider: blue hr marking the old/new boundary */
  .backlogDivider {
    margin: 0;
  }
  .backlogDivider hr {
    margin: 20px 0;
    border: none;
    border-top: 1px solid #1e72ff;
  }
  .stickyAvatar {
    position: absolute;
    left: 0;
    display: block;
    z-index: 5;
    pointer-events: none;
    /* 30ms linear transition smooths the `top` updates between scroll
     * events. IRCCloud has transition: all 0s but the browser-driven
     * scroll events fire at 60fps so it doesn't need one. We add this
     * short transition to mask any micro-jitter and match the perceived
     * smoothness of the original IRCCloud client. */
    transition: top 30ms linear;
    will-change: top;
  }
</style>
