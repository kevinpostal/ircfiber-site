<script lang="ts">
  import { untrack, flushSync, tick } from 'svelte';
  import { ircState, getActiveBufferObj, getActiveNetwork, isMessageUnseen, getLastSeenMessage, countMessagesBetween, countImportantMessagesBetween, clearUnseenHighlightsAfter, unseenHighlightCountAfter, updateBottomSeen, setBacklogDivider, getTypersForBuffer } from '../stores/ircStore.svelte';
  import { getClearedAt, setLastSeen, getBufferPrefs, getFocusSeen, getBottomSeen, getLastSeen, clearFocusSeen, clearBottomSeen, setBottomSeen } from '../stores/preferences.svelte';
  import { preprocessMessages } from '../lib/messageBuilder';
  import MessageRow from './MessageRow.svelte';
  import DateChange from './DateChange.svelte';
  import ServerLogTimeline from './ServerLogTimeline.svelte';

  import SeenDivider from './SeenDivider.svelte';
  import LoadMore from './LoadMore.svelte';
  import ChatterBar from './ChatterBar.svelte';
  import ScrollClock from './ScrollClock.svelte';
  import { isSkippedCommand, getMsgDate, formatDate, formatDateTimeTitle, formatShortRelativeTime, stringHash, stripPrefix, stripHash } from '../lib/utils';
  import { perfMark, perfMeasure } from '../lib/perf';
  import { dividerPos as sharedDividerPos, animateScrollTo } from '../lib/scroll';
  import { captureScrollAnchor, takeScrollAnchor } from '../lib/scrollAnchor';
  import type { IRCMessage, Member, Network } from '../types';

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
  let cachedAtBottom = $state(true);
  let wasRecentlyAtBottom = $state(true);
  let recentlyScrolledTimeout: ReturnType<typeof setTimeout> | null = null;
  // Pending unconditional snap for a freshly-opened buffer. Set when the
  // bufferKey changes but the container is not yet bound (first mount
  // after a refresh) so the normal `if (!container) return` early-exit
  // doesn't swallow the initial bottom snap. Cleared on the next run
  // once the container exists and we have snapped.
  let pendingInitialSnap = false;
  let initialSnapDone = true;
  // rAF coalescing for scroll auxiliary state (chatter counts, clock,
  // sticky avatar) — mirrors IRCCloud's batchRendering flag that ignores
  // scroll events during batch flush. Only the heavy getBoundingClientRect
  // + elementsFromPoint work is deferred; cachedAtBottom/cachedAtTop
  // tracking stays synchronous so infiniscroll doesn't miss the top.
  let scrollRafPending = false;

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
  let stickyAvatarEl = $state<HTMLDivElement | null>(null);
  let batchRendering = false;
  // IRCCloud-style: capture pinBottom BEFORE each reactive flush runs.
  // Without this, cachedAtBottom can be stale by the time the $effect
  // fires, causing an unnecessary scrollToBottom.
  let pinBottomBeforeFlush = false;

  // IRCCloud ScrollClockView: timestamp of the message at the top of the
  // scroll; null hides the clock (at bottom / no upper message).
  let clockTs = $state<number | null>(null);

  const bufferKey = $derived(`${ircState.activeBuffer.networkId}:${ircState.activeBuffer.bufferName}`);
  // Don't show "No messages yet" until history has been loaded for this buffer.
  // While ircState.messages[bufferKey] is undefined the REST/sync fetch is
  // still in flight — showing the empty hint during this window causes a
  // flash (empty text → messages) on every channel that has history, e.g.
  // /irc/Super%20Nets/channel/superbowl. Once the buffer key exists (even
  // as an empty array) we know the load completed and the empty hint is
  // truthful. See App.svelte loadBufferHistory which ensures an empty
  // array is written after a zero-result fetch so this flips to true.
  const hasHistoryLoaded = $derived(ircState.messages[bufferKey] !== undefined);

  // Server log view needs raw (un-grouped) messages — preprocessing
  // merges consecutive 372/375 MOTD lines into MOTD_GROUP blocks that
  // our classifier doesn't understand, burying them in "Raw IRC traffic".
  // FIX: return the original array reference without spreading. The previous
  // spread `[...arr]` created a new array on every store mutation, even when
  // a different buffer's messages changed (e.g. a channel PRIVMSG while
  // viewing _server), causing ServerLogTimeline to re-group and flicker.
  // With reference identity, downstream deriveds only re-run when the
  // _server array itself is reassigned (new message for _server).
  const rawMessages = $derived(ircState.messages[bufferKey] ?? []);

  // _server buffers use the ServerLogTimeline card view instead of
  // the flat message-row view — each connection attempt becomes a card
  // with a header, a phase timeline, MOTD, and collapsed details blocks
  // for raw IRC traffic. See frontend/src/lib/serverLogGroups.ts.
  const isServerBuffer = $derived(ircState.activeBuffer.bufferName === '_server');
  const activeNetwork = $derived(getActiveNetwork());

  // IRCCloud-style incremental preprocessing: the ircState maintains a
  // `processedMessages[key]` cache that is updated incrementally on every
  // append / prepend.  This derived reads from the cache (O(1) per render)
  // and only falls back to a full preprocess when the cache is missing.
  //
  // IRCCloud-style commands that represent join/part/quit/nick events.
  // Show/hide for these is controlled by the `showJoinPart` buffer pref.
  const JOIN_PART_COMMANDS = new Set(['JOIN', 'PART', 'QUIT', 'NICK', 'CHGHOST', 'JOINPART_GROUP', 'DISCO_GROUP']);

  function filterJoinPart(messages: IRCMessage[]): IRCMessage[] {
    if (messages.length === 0) return messages;
    const showJp = ircState.activeBuffer.networkId && ircState.activeBuffer.bufferName
      ? getBufferPrefs(ircState.activeBuffer.networkId, ircState.activeBuffer.bufferName).showJoinPart
      : true;
    if (showJp ?? true) return messages; // shortcut: show everything
    return messages.filter(m => !JOIN_PART_COMMANDS.has(m.command));
  }

  const AWAY_COMMANDS = new Set(['AWAY']);

  function filterAway(messages: IRCMessage[]): IRCMessage[] {
    if (messages.length === 0) return messages;
    const showAway = ircState.activeBuffer.networkId && ircState.activeBuffer.bufferName
      ? getBufferPrefs(ircState.activeBuffer.networkId, ircState.activeBuffer.bufferName).showAway
      : true;
    if (showAway ?? true) return messages;
    return messages.filter(m => !AWAY_COMMANDS.has(m.command));
  }

  // (cold start / migration).  The clearedAt filter and empty-message
  // filter are still applied on top of the cached processed array because
  // they depend on UI state, not on the raw stream.
  const processedMessages = $derived.by(() => {
    const t0 = perfMark('processedMessages:start');
    const key = bufferKey;
    const cached = ircState.processedMessages[key];
    if (cached) {
      const clearedAt = ircState.activeBuffer.networkId && ircState.activeBuffer.bufferName
        ? getClearedAt(ircState.activeBuffer.networkId, ircState.activeBuffer.bufferName) : null;
      if (!clearedAt) {
        const jpFiltered = filterJoinPart(cached);
        const awayFiltered = filterAway(jpFiltered);
        perfMeasure(`processedMessages len=${awayFiltered.length} (cache hit)`, t0);
        return awayFiltered;
      }
      const filtered = cached.filter(m => (m.t || 0) > clearedAt);
      const jpFiltered = filterJoinPart(filtered);
      const awayFiltered = filterAway(jpFiltered);
      perfMeasure(`processedMessages len=${awayFiltered.length} (cache hit, cleared)`, t0);
      return awayFiltered;
    }
    // Fallback: cold start / cache miss.  We can't write to the cache
    // from inside a $derived (Svelte 5 forbids state mutation in derived
    // expressions), so we compute locally and rely on the next
    // batchAppendMessages / appendMessage call to populate the cache.
    // The ircState setters always build the cache as a side effect, so
    // the next reactive tick will hit the cache path.
    const raw = ircState.messages[key] ?? [];
    const clearedAt = ircState.activeBuffer.networkId && ircState.activeBuffer.bufferName
      ? getClearedAt(ircState.activeBuffer.networkId, ircState.activeBuffer.bufferName) : null;
    const cleared = clearedAt ? raw.filter(m => (m.t || 0) > clearedAt) : raw;
    const noEmpty = cleared.filter(m => {
      if (m.lines || m.sentences || m.events) return true;
      return typeof m.text === 'string' && m.text.trim() !== '';
    });
    const result = preprocessMessages(noEmpty);
    const jpFiltered = filterJoinPart(result);
    const awayFiltered = filterAway(jpFiltered);
    perfMeasure(`processedMessages len=${awayFiltered.length} (cold)`, t0);
    return awayFiltered;
  });

  function checkSameAuthor(msg: IRCMessage, prev: IRCMessage | null): boolean;
  function checkSameAuthor(msg: IRCMessage, messages: IRCMessage[], index: number): boolean;
  function checkSameAuthor(msg: IRCMessage, prevOrMessages: IRCMessage[] | IRCMessage | null, index?: number): boolean {
    // Actions (/me) are never grouped — they always render as a standalone
    // row with their own avatar/inline header. A normal message that
    // follows an action from the same nick must start a new group so its
    // nick/avatar are visible (bug: "grouped under the action/me which
    // does not have the nick and avatar correct").
    if (msg.type === 'action') return false;
    if (msg.command !== 'PRIVMSG' && msg.command !== 'NOTICE') return false;
    const nick = stripPrefix(msg.nick || '');
    if (!nick) return false;
    let prev: IRCMessage | null = null;
    if (Array.isArray(prevOrMessages) && typeof index === 'number') {
      // Smart grouping: skip over JOIN/PART/NICK system messages so a
      // single "Zod joined" between two bursts from the same nick
      // doesn't split the bubble — but an action DOES split the bubble.
      for (let j = index - 1; j >= 0; j--) {
        const cand = prevOrMessages[j];
        if (cand.type === 'action') return false;
        if ((cand.command === 'PRIVMSG' || cand.command === 'NOTICE') && cand.type !== 'action') { prev = cand; break; }
        if (JOIN_PART_COMMANDS.has(cand.command)) continue;
        if (cand.command === 'MOTD_GROUP' || /^\d{3}$/.test(cand.command)) continue;
        continue;
      }
      if (!prev) return false;
    } else {
      prev = prevOrMessages as IRCMessage | null;
      if (!prev) return false;
      if (prev.type === 'action') return false;
      if (prev.command !== 'PRIVMSG' && prev.command !== 'NOTICE') return false;
    }
    const prevNick = stripPrefix(prev.nick || '');
    if (!prevNick || prevNick !== nick) return false;
    return true;
  }

  // ── IRCCloud parity: seen dividers ──
  // Priority: bottomSeen (scrolled up) > focusSeen (tabbed out) > lastSeen (new messages)
  // Matches BufferView.showSeenMarker() which tries showBottomSeen() || showFocusSeen() || showLastSeen().
  // Only one divider per buffer is visible at a time; lastSeenEid avoids duplicates
  // for the same eid on re-render (BufferView.lastSeenEid check).
  function getSeenDividerType(msg: IRCMessage, prev: IRCMessage | null): 'focus' | 'bottom' | 'last' | null {
    if (!prev) return null;
    const nid = ircState.activeBuffer.networkId;
    const buf = ircState.activeBuffer.bufferName;
    if (!nid || !buf) return null;
    const key = `${nid}:${buf}`;
    // bottomSeen has highest priority (scrolled up)
    const bottomTs = getBottomSeen(nid, buf);
    if (bottomTs !== null && (prev.t || 0) <= bottomTs && (msg.t || 0) > bottomTs) {
      if (lastSeenEidMap[key] === (msg.eid ?? msg.msgid)) return null;
      return 'bottom';
    }
    const focusTs = getFocusSeen(nid, buf);
    if (focusTs !== null && (prev.t || 0) <= focusTs && (msg.t || 0) > focusTs) {
      if (lastSeenEidMap[key] === (msg.eid ?? msg.msgid)) return null;
      return 'focus';
    }
    const lastTs = getLastSeen(nid, buf);
    if (lastTs !== null && (prev.t || 0) <= lastTs && (msg.t || 0) > lastTs) {
      // Hide lastSeen when at the end (no next visible) — matches BufferView.renderLastSeenDivider's hidden
      const all = ircState.messages[key] ?? [];
      const isLastVisible = all.length > 0 && (all[all.length - 1].eid === msg.eid || all[all.length - 1].msgid === msg.msgid);
      if (isLastVisible) return null;
      if (lastSeenEidMap[key] === (msg.eid ?? msg.msgid)) return null;
      lastSeenEidMap[key] = msg.eid ?? msg.msgid ?? (msg.t ?? 0);
      return 'last';
    }
    if (ircState.lastSeenMsgTime && ircState.focusLost) {
      if ((prev.t || 0) <= ircState.lastSeenMsgTime && (msg.t || 0) > ircState.lastSeenMsgTime) {
        if (lastSeenEidMap[key] === (msg.eid ?? msg.msgid)) return null;
        return 'focus';
      }
    }
    return null;
  }

  // Legacy alias for tests
  function shouldShowSeenDivider(msg: IRCMessage, prev: IRCMessage | null): boolean {
    return getSeenDividerType(msg, prev) !== null;
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
  // stick-to-bottom-svelte's STICK_TO_BOTTOM_OFFSET_PX: after the user
  // scrolls up (breaking the stick), a DOWNWARD scroll into this band
  // re-engages the bottom-stick. A stopped position within the band does
  // NOT re-engage — reading 50px up is never yanked.
  const STICK_BAND_PX = 70;
  let renderStart = $state(0);
  // IRCCloud BufferLogView.lastSeenEid — track the eid for which the
  // "New messages" divider was last rendered, per buffer, to avoid
  // duplicate dividers for the same eid on re-render (postProcess
  // lastSeenEid check). Plain object, not $state, to allow mutation
  // during render without triggering Svelte reactivity.
  let lastSeenEidMap: Record<string, string | number> = {};

  // IRCCloud BufferLogView.bufferMessage/checkFlush: while the user is
  // scrolled up reading, incoming messages are buffered and the DOM is NOT
  // touched — they flush when the user returns to the bottom. We freeze the
  // window's end at the last rendered message when leaving the bottom, so
  // realtime traffic causes zero layout work during a reading session.
  let renderEndKey = $state('');

  function itemKeyOf(msg: IRCMessage): string {
    if (msg.label) return `l:${msg.label}`;
    if (msg.eid != null) return `e:${msg.eid}`;
    return msg.msgid || `t:${msg.t}`;
  }

  // Backstop against duplicate keys reaching the {#each}. The store is
  // supposed to dedup by eid/msgid before messages land here, but if a
  // message slips through with no eid AND no msgid AND the same `t` as
  // another message, the bare `t:${t}` key would collide. The tiebreaker
  // suffix is the message's absolute index in processedMessages so the key
  // stays stable when the render window shifts (trim/reveal), letting Svelte
  // reuse the DOM instead of recreating rows and flashing ANSI art.
  function stableKey(msg: IRCMessage, absoluteIndex: number): string {
    const base = itemKeyOf(msg);
    return `${base}#${absoluteIndex}`;
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
  // Pixel-aware for ANSI art: one blockArt row can be 20-100 visual lines
  // (thousands of spans) so count alone under-trims. Also trim when
  // scrollHeight exceeds ~12k px (roughly 200 normal rows).
  function maybeTrim(): void {
    const len = processedMessages.length;
    const start = untrack(() => renderStart);
    const countOver = len - start > TRIM_DETECT_THRESHOLD;
    const pixelOver = !!container && container.scrollHeight > 12000;
    if (countOver || pixelOver) {
      // Keep 200 normally, but if pixel-heavy keep fewer to bound paint.
      const keep = pixelOver && !countOver ? 150 : TRIM_THRESHOLD;
      const newStart = Math.max(0, len - keep);
      if (newStart !== start) {
        renderStart = newStart;
        // If we trimmed while pinned at bottom, keep the viewport pinned.
        // Without this, scrollTop stays at old bottom (too large) and gets
        // clamped, but the 200ms resnap poll sees scrollTop < prevScrollTop
        // and clears the bottom stick, leaving a visible "snap up".
        if (cachedAtBottom && container) {
          // Defer to next tick + rAF so DOM has updated scrollHeight
          // and layout has flushed, then force to true bottom and
          // schedule the resnap poll to catch late image/decode growth.
          tick().then(() => {
            if (container && cachedAtBottom) {
              container.scrollTop = container.scrollHeight;
              prevScrollTop = container.scrollTop;
              prevScrollHeight = container.scrollHeight;
              requestAnimationFrame(() => {
                if (container && cachedAtBottom) {
                  container.scrollTop = container.scrollHeight;
                  prevScrollTop = container.scrollTop;
                  prevScrollHeight = container.scrollHeight;
                  schedulePinnedResnap();
                }
              });
            }
          });
        }
      }
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

    // IRCCloud checkInfiniscroll: isScrolledToTop() is scrollTop===0 exact, not <=200.
    // Only fire when truly at top (0), not 200px before. Prevents eager
    // 3×200 pre-load that hid the continuous-scroll feel.
    const atTop = container.scrollTop <= 0;
    const scrollBottom = container.clientHeight + Math.ceil(container.scrollTop);
    const pinBottom = container.scrollHeight - scrollBottom <= 1;

    const boundary = processedMessages[start];
    if (boundary && ircState.activeBuffer.networkId && ircState.activeBuffer.bufferName) {
      setBacklogDivider(ircState.activeBuffer.networkId, ircState.activeBuffer.bufferName, itemKeyOf(boundary));
    }
    const oldH = container.scrollHeight;
    const oldTop = container.scrollTop;
    captureScrollAnchor(container);
    const anchorBefore = takeScrollAnchor();
    const calc = Math.max(0, start - BATCH_SIZE);
    windowRevealInProgress = true;
    renderStart = calc;
    // Consume the mark so the $effect doesn't run the settle a second time.
    handledDividerMark = untrack(() => backlogDividerMark);

    // Render synchronously, then settle — no rAF gap for queued wheel
    // events to fire a second reveal from scrollTop 0.
    flushSync();
    windowRevealInProgress = false;
    if (!pinBottom) {
      // IRCCloud fetched() half-way scroll: divider at 152px from top (min 48), not exact anchor.
      // This makes the user feel constantly scrolling up – each wheel-up reveals a new batch
      // and the scrollbar stays in the middle, not wedged at 0. Matches
      // common-5650bddb.js: var a=Math.round(r.position().top);this.scrollTo(a-31),this.scrollTo(Math.max(a-152,48),{animate:!0})
      const divider = container.querySelector('.backlogDivider') as HTMLElement | null;
      if (divider) {
        const a = Math.round(dividerPos(divider));
        // First, jump to a-31 (like IRCCloud's immediate scrollTo), then animate to max(a-152,48)
        container.scrollTop = a - 31;
        const target = Math.max(a - 152, 48);
        animateScrollTo(container, target, 100);
      } else if (atTop && anchorBefore) {
        // Fallback when divider not yet rendered (rare): exact anchor
        const rows = Array.from(container.querySelectorAll('.row.messageRow')) as HTMLElement[];
        const match = rows.find((r) => (r.dataset.msgid || 't:' + r.dataset.time) === anchorBefore.msgid);
        if (match) {
          const displacement = match.getBoundingClientRect().top - anchorBefore.top;
          if (displacement !== 0) container.scrollTop = oldTop + displacement;
        } else {
          const delta = container.scrollHeight - oldH;
          if (delta !== 0) container.scrollTop = oldTop + delta;
        }
      } else if (atTop) {
        preserveReadingPosition(container, oldTop);
      } else {
        const delta = container.scrollHeight - oldH;
        if (delta !== 0) container.scrollTop = oldTop + delta;
      }
      prevScrollTop = container.scrollTop;
      prevScrollHeight = container.scrollHeight;
      cachedAtTop = container.scrollTop <= 0;
      cachedAtBottom = false;
      wasRecentlyAtBottom = false;
    }
    return true;
  }

  let InfiniteLoader: any = $state(null);
  let LoaderStateClass: any = $state(null);
  let loaderState: any = $state(null);
  // Dynamically import svelte-infinite only in non-test (browser) to avoid vitest Svelte 3 compat issues
  import { onMount } from 'svelte';
  onMount(async () => {
    if (import.meta.env.MODE !== 'test') {
      const mod = await import('svelte-infinite');
      InfiniteLoader = mod.InfiniteLoader;
      LoaderStateClass = mod.LoaderState;
      loaderState = new LoaderStateClass();
    }
  });

  const infiniteOptions = $derived({
    root: container,
    rootMargin: "200px 0px 0px 0px"
  });

  $effect(() => {
    // Reset loader when switching buffers - ensures top sentinel re-arms
    void bufferKey;
    loaderState?.reset();
  });

  $effect(() => {
    // If history just loaded (hasHistoryLoaded true) and loader was in COMPLETE from earlier empty check, reset to READY
    // This fixes the case where InfiniteLoader triggered with len 0 before history arrived (existing.length===0 -> complete)
    // and then history arrived via App's loadHistory (150), but loader stayed COMPLETE and wouldn't trigger for top scroll.
    void hasHistoryLoaded;
    if (hasHistoryLoaded && loaderState?.status === 'COMPLETE') {
      loaderState.reset();
    }
  });

  let infiniteLoading = $state(false);
  async function infiniteHandler() {
    if (infiniteLoading) {
      return;
    }
    infiniteLoading = true;
    try {
      // In-memory batches first (instant, no spinner) — reveal ALL
      // remaining in-memory batches while the user stays at the top, then
      // fall through to the network. (A single reveal consumed the whole
      // trigger and returned, so a trimmed window — e.g. renderStart=50
      // from maybeTrim during a flood — was revealed and then loading
      // stopped because the sentinel never re-fires at scrollTop=0.)
      let revealGuard = 0;
      while (container && container.scrollTop <= 200) {
        if (!revealBacklogFromMemory()) break;
        revealGuard++;
        if (revealGuard >= 20) break;
      }
      if (!onLoadMore) {
        loaderState?.complete();
        return;
      }
      // Don't trigger network load while initial history is still loading
      if (!hasHistoryLoaded) {
        loaderState?.loaded();
        return;
      }
      let batches = 0;
      let completed = false;
      const MAX_BATCHES_PER_TRIGGER = 3;
      while (batches < MAX_BATCHES_PER_TRIGGER) {
        const hasMore = await onLoadMore();
        if (!hasMore) {
          loaderState?.complete();
          completed = true;
          break;
        }
        loaderState?.loaded();
        batches++;
        if (!container || container.scrollTop > 200) break;
        if (batches < MAX_BATCHES_PER_TRIGGER) {
          await new Promise((r) => setTimeout(r, 350));
        }
      }
      if (!completed && container && container.scrollTop <= 200 && !isServerBuffer) {
        setTimeout(() => {
          if (container && container.scrollTop <= 200 && !infiniteLoading && !isServerBuffer) {
            void infiniteHandler();
          }
        }, 500);
      }
    } catch (e) {
      loaderState?.error();
    } finally {
      infiniteLoading = false;
    }
  }
  // Pre-compute date separators over the rendered window
  const messagesWithDates = $derived.by(() => {
    const all = processedMessages;
    const start = Math.max(0, Math.min(renderStart, all.length));
    let end = all.length;
    if (renderEndKey) {
      // Resolve the freeze key to the LAST message that carries it.
      // itemKeyOf collisions (msgid-less messages sharing a timestamp)
      // make the first match the WRONG message: the frozen tail would
      // resolve to index 0 and, once renderStart reaches 0 (whole backlog
      // revealed), the window would collapse to a single row.
      let endIdx = -1;
      for (let i = all.length - 1; i >= 0; i--) {
        if (itemKeyOf(all[i]) === renderEndKey) { endIdx = i; break; }
      }
      if (endIdx >= start) end = endIdx + 1;
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
        itemKeyOf(msg) === dividerMark;
      if (showBacklogDivider) dividerPlaced = true;
      // Use the absolute index in processedMessages as the tiebreaker so the
      // key stays stable when the render window shifts (trim/reveal). Without
      // this, every visible message gets a new key on trim and Svelte recreates
      // the DOM rows, causing ANSI art and color backgrounds to flicker.
      return { msg, showDate, msgDate, prevDate, prevMsg, showBacklogDivider, _key: stableKey(msg, start + i) };
    });
  });

  // IRCCloud seen-divider placement: compute once per rendered window, not per-row.
  // Using a derived avoids per-row reactive reads inside {#each} which would
  // cause the each block to re-subscribe on every scroll event and break
  // the scroll-clock / buffering tests (probeRow timing).
  // IRCCloud seen-divider placement: compute once per rendered window, not per-row.
  // Only one divider per buffer is visible at a time, with priority
  // bottomSeen (scrolled up) > focusSeen (tabbed out) > lastSeen (new messages)
  // Matches BufferView.showSeenMarker() and lastSeenEid deduplication.
  const seenDividerByKey = $derived.by(() => {
    const m = new Map<string, 'focus' | 'bottom' | 'last'>();
    const nid = ircState.activeBuffer.networkId;
    const buf = ircState.activeBuffer.bufferName;
    if (!nid || !buf) return m;
    const key = `${nid}:${buf}`;
    const bufferMessages = ircState.messages[key] ?? [];
    const bottomTs = getBottomSeen(nid, buf);
    const focusTs = getFocusSeen(nid, buf);
    const lastTs = getLastSeen(nid, buf);
    const globalTs = ircState.lastSeenMsgTime && ircState.focusLost ? ircState.lastSeenMsgTime : null;
    // Helper to find first msg after seenTs in the current window
    const findKey = (seenTs: number | null): string | null => {
      if (seenTs === null) return null;
      for (let i = 1; i < messagesWithDates.length; i++) {
        const prev = messagesWithDates[i - 1].msg;
        const cur = messagesWithDates[i].msg;
        if ((prev.t || 0) <= seenTs && (cur.t || 0) > seenTs) {
          return messagesWithDates[i]._key;
        }
      }
      return null;
    };
    // Priority: bottom > focus > last > global
    // IRCCloud always shows "New messages since you scrolled up" when scrolled
    // up, regardless of whether the window is focused. The previous `isActive`
    // guard that hid bottomSeen when focused caused the divider to flicker
    // between bottom and last as focus/visibility toggled, and as new messages
    // arrived within the 30s tick interval.
    let bottomKey: string | null = null;
    if (!cachedAtBottom && bottomTs !== null) {
      for (let i = 1; i < messagesWithDates.length; i++) {
        const prev = messagesWithDates[i - 1].msg;
        const cur = messagesWithDates[i].msg;
        if ((prev.t || 0) <= bottomTs && (cur.t || 0) > bottomTs) {
          const curNickLower = stripPrefix(cur.nick || '').toLowerCase();
          const myNickLower = (activeNetwork?.currentNick || '').toLowerCase();
          if (curNickLower === myNickLower && myNickLower !== '') {
            // First new after you scrolled up is your own — look for next
            // non-own new message; don't show divider for your own echo.
            for (let j = i + 1; j < messagesWithDates.length; j++) {
              const nxt = messagesWithDates[j].msg;
              if (stripPrefix(nxt.nick || '').toLowerCase() !== myNickLower) {
                bottomKey = messagesWithDates[j]._key;
                break;
              }
            }
          } else {
            bottomKey = messagesWithDates[i]._key;
          }
          break;
        }
      }
    }
    if (bottomKey) {
      m.set(bottomKey, 'bottom');
      return m;
    }
    const focusKey = findKey(focusTs);
    if (focusKey) {
      m.set(focusKey, 'focus');
      return m;
    }
    const lastKey = findKey(lastTs);
    if (lastKey) {
      const lastMsg = messagesWithDates.find(item => item._key === lastKey)?.msg;
      // Don't show "New messages" divider when you are actively at bottom
      // and the new messages are yours. Typing 1 or 2 messages while pinned
      // should not flash the divider – it is for unread messages from others
      // while you were away/scrolled up. Matches IRCCloud's shouldShowSeen.
      const isActiveNow = !ircState.focusLost && typeof document !== 'undefined' && document.hasFocus() && document.visibilityState === 'visible';
      const isAtBottomNow = cachedAtBottom || (!container || container.scrollHeight <= container.clientHeight + 1 || Math.abs(container.scrollHeight - container.scrollTop - container.clientHeight) <= 1);
      if (isActiveNow && isAtBottomNow) {
        return m;
      }
      if (lastMsg) {
        const curNick = activeNetwork?.currentNick || '';
        if (curNick && stripPrefix(lastMsg.nick || '') === stripPrefix(curNick)) {
          return m;
        }
      }
      // Hide lastSeen when at the end (no next visible) — matches renderLastSeenDivider's hidden
      const isLastVisible = lastMsg && bufferMessages.length > 0 && (bufferMessages[bufferMessages.length - 1].eid === lastMsg.eid || bufferMessages[bufferMessages.length - 1].msgid === lastMsg.msgid);
      if (!isLastVisible) {
        const lastEid = lastMsg?.eid ?? lastMsg?.msgid ?? (lastMsg?.t ?? 0);
        if (lastSeenEidMap[key] !== lastEid) {
          m.set(lastKey, 'last');
          lastSeenEidMap[key] = lastEid;
        } else {
          m.set(lastKey, 'last');
        }
      }
      return m;
    }
    const globalKey = findKey(globalTs);
    if (globalKey) {
      m.set(globalKey, 'focus');
    }
    return m;
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
  //   - if atTop && divider → snap to (dividerPos - 31) so the divider
  //     (and a sliver of the new batch) is visible; NO animated scroll —
  //     the swing overrides the user's scroll-up input and reads as a
  //     forced jump back down
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

  // Divider position in scroll-content coordinates (jQuery .position().top
  // equivalent for the scroll container).
  function dividerPos(divider: HTMLElement): number {
    if (!container) return 0;
    return sharedDividerPos(container, divider);
  }

  let lastFirstProcessedKey = '';
  let lastProcessedLength = 0;
  let windowRevealInProgress = false;

  // Preserve the reading position across a history prepend: shift scrollTop
  // by the captured anchor row's ACTUAL displacement (captured by
  // handleLoadMore right before the store mutation). Only applies when the
  // user has not scrolled since the last scroll event — otherwise the
  // browser's own anchoring already adjusted.
  function preserveReadingPosition(c: HTMLDivElement | null, expectedScrollTop: number): void {
    if (!c || c.scrollTop !== expectedScrollTop) return;
    const anchor = takeScrollAnchor();
    if (!anchor) return;
    // Defer to the next frame: the fetch indicator (loading row) is removed
    // when the loader settles, and its removal shifts the content — the
    // final anchor displacement must include it for the reading position
    // to be preserved exactly.
    requestAnimationFrame(() => {
      if (!c || c.scrollTop !== expectedScrollTop) return; // user scrolled
      const rows = Array.from(c.querySelectorAll('.row.messageRow')) as HTMLElement[];
      const match = rows.find((r) => (r.dataset.msgid || 't:' + r.dataset.time) === anchor.msgid);
      if (!match) return;
      const displacement = match.getBoundingClientRect().top - anchor.top;
      if (displacement !== 0) c.scrollTop = expectedScrollTop + displacement;
    });
  }

  // ── Message entrance animation ───────────────────────────────────────
  // Tracks which message keys should get the .messageEntrance class.
  // Only the batch head (firstAuthor rows or non-grouped messages) gets
  // the slide-in; same-author continuations get a subtler fade.
  let entranceKeys = $state(new Set<string>());
  let lastBottomKey = '';

  function scheduleEntranceCleanup(): void {
    setTimeout(() => {
      entranceKeys = new Set();
    }, 150);
  }

  // IRCCloud-style: when the scroll container shrinks (e.g. a typing
  // Force-scroll trigger: when the user sends a message, InputArea
  // increments forceScrollToBottomNonce (see ircStore.svelte). We
  // always snap to the bottom in that case — even if the user scrolled
  // up to inspect history. IRCCloud always shows you your own message
  // after you hit Enter; we match that. Reads forceScrollToBottomNonce
  // here so the effect re-runs whenever it changes; reads isServerBuffer
  // first so server-log views (where the user owns their scroll position
  // while inspecting connection history) are excluded.
  //
  // Singleton force-scroll: when the user sends a message (or navigates
  // to a buffer), snap to the bottom immediately with a synchronous
  // layout reflow so the clamp lands on the true scrollHeight. Then
  // run a SINGLE short polling chain (3 × 200ms = 600ms) to catch any
  // late-arriving content. A new nonce while polling cancels the old
  // chain and starts a fresh one — critical for the rapid-typing case:
  // typing 5-6 messages in a row MUST NOT start 5-6 overlapping chains,
  // each doing flushSync + layout reflow + 10 polls (that was the
  // source of the UI lag that made the user say "it lags and takes a
  // while to show them").
  let lastForceScrollNonce = 0;
  let pendingPollTimer: ReturnType<typeof setTimeout> | null = null;

  // ── Pinned re-snap settle chain ──────────────────────────────────
  // Late layout can land AFTER the synchronous snap + single rAF:
  //   - the 120ms messageEntrance slide-in (firstAuthor / action rows)
  //   - image/embed decode after the row renders
  //   - sync-driven member enrichment (WHOIS → realname on the next
  //     sync) growing the author row — the author-realname span appears
  //     after the message row was already snapped into view
  // Each of these grows scrollHeight after the snap, leaving the
  // viewport a few pixels short of the very bottom while the user is
  // pinned ("the scrollbar isn't forced to the very bottom"). We run a
  // short poll chain (4 × 200ms) that re-snaps while cachedAtBottom is
  // still true, and cancels/restarts on every snap so a busy channel
  // never stacks chains. Reading scrolled-up history is never forced —
  // the poll bails the moment the user scrolls away.
  let pinnedResnapTimer: ReturnType<typeof setTimeout> | null = null;
  function schedulePinnedResnap(maxPolls: number = 8): void {
    if (pinnedResnapTimer) { clearTimeout(pinnedResnapTimer); pinnedResnapTimer = null; }
    if (pendingPollTimer) { clearTimeout(pendingPollTimer); pendingPollTimer = null; }
    let polls = 0;
  function poll(): void {
      pinnedResnapTimer = null;
      if (!container) return;
      if (!cachedAtBottom) return;
      if (container.scrollTop < prevScrollTop) {
        // Trim reduces scrollHeight and clamps scrollTop down — this is
        // not a user scroll-up. Only clear the stick if height didn't shrink.
        if (container.scrollHeight >= prevScrollHeight) {
          cachedAtBottom = false;
          return;
        }
        // Programmatic trim: update baseline and keep polling
        prevScrollTop = container.scrollTop;
        prevScrollHeight = container.scrollHeight;
      }
      const bottom = container.scrollHeight - container.clientHeight;
      if (bottom - container.scrollTop > 1) {
        container.scrollTop = container.scrollHeight;
        prevScrollTop = container.scrollTop;
        prevScrollHeight = container.scrollHeight;
      }
      polls += 1;
      if (polls < maxPolls) pinnedResnapTimer = setTimeout(poll, 200);
    }
    pinnedResnapTimer = setTimeout(poll, 200);
  }
  function ensurePinned(): void {
    if (!container) return;
    flushSync();
    container.scrollTop = container.scrollHeight;
    void container.scrollHeight;
    container.scrollTop = container.scrollHeight;
    cachedAtBottom = true;
    schedulePinnedResnap();
  }

  $effect(() => {
    if (isServerBuffer) {
      lastForceScrollNonce = ircState.forceScrollToBottomNonce;
      return;
    }
    const nonce = ircState.forceScrollToBottomNonce;
    if (nonce === lastForceScrollNonce) return;
    if (!container) return;
    lastForceScrollNonce = nonce;
    pendingInitialSnap = false;
    initialSnapDone = true;
    snapToBottom(container);
  });
  function snapToBottom(c: HTMLDivElement): void {
    renderEndKey = '';
    if (pendingPollTimer) { clearTimeout(pendingPollTimer); pendingPollTimer = null; }
    if (pinnedResnapTimer) { clearTimeout(pinnedResnapTimer); pinnedResnapTimer = null; }
    let didFlush = true;
    try { flushSync(); } catch { didFlush = false; }
    const msgs = untrack(() => processedMessages);
    if (msgs.length > 0) {
      renderStart = Math.max(0, msgs.length - BATCH_SIZE);
    }
    try { flushSync(); } catch { didFlush = false; }
    const doScroll = () => {
      c.scrollTop = c.scrollHeight;
      void c.scrollHeight;
      c.scrollTop = c.scrollHeight;
      cachedAtBottom = true;
      prevScrollTop = c.scrollTop;
      prevScrollHeight = c.scrollHeight;
      requestAnimationFrame(() => {
        if (cachedAtBottom && c) {
          c.scrollTop = c.scrollHeight;
          prevScrollTop = c.scrollTop;
          prevScrollHeight = c.scrollHeight;
        }
      });
      schedulePinnedResnap(3);
    };
    if (didFlush) doScroll();
    else tick().then(doScroll);
  }

  // Keep pinned viewport at the true bottom when late layout grows the
  // content (image decode, text-wrap fetch, member enrichment). The old
  // ResizeObserver on the viewport itself never fired for scrollHeight
  // growth (overflow content doesn't resize the viewport), so page-load
  // with image previews left the viewport ~250 px short. We now:
  //  (a) capture `load` events from <img> (bubbles in capture phase)
  //  (b) ResizeObserve every .directEmbedWrap / .editor that appears
  //  (c) keep the viewport RO as a fallback for window resizes.
  $effect(() => {
    if (isServerBuffer) return;
    const el = container;
    if (!el) return;
    const snapIfPinned = () => {
      if (!container) return;
      if (!cachedAtBottom || container.scrollTop < prevScrollTop - 1) return;
      const scrollHeight = container.scrollHeight;
      const offsetHeight = container.clientHeight;
      const scrollPos = Math.ceil(container.scrollTop);
      const bottom = (scrollHeight - offsetHeight) + 1;
      if ((bottom - scrollPos) > 1) {
        container.scrollTop = scrollHeight;
        // Schedule a second rAF to catch the frame after the RO's
        // async callback when the image's display:inline-block hasn't
        // flushed yet (preload snap vs onLoad race).
        requestAnimationFrame(() => {
          if (!container || !cachedAtBottom) return;
          const h2 = container.scrollHeight;
          const off2 = container.clientHeight;
          const pos2 = Math.ceil(container.scrollTop);
          if ((h2 - off2 + 1 - pos2) > 1) container.scrollTop = h2;
        });
      }
    };
    const ro = new ResizeObserver(() => snapIfPinned());
    ro.observe(el);
    const mo = new MutationObserver(() => {
      // Re-observe any new embed/editor nodes and snap after their
      // initial zero-height → image-height transition.
      el.querySelectorAll('.directEmbedWrap, .editor').forEach((n) => {
        try { ro.observe(n as Element); } catch {}
      });
      snapIfPinned();
    });
    mo.observe(el, { childList: true, subtree: true });
    // Initial observe of embeds already in DOM (page-load history)
    el.querySelectorAll('.directEmbedWrap, .editor').forEach((n) => {
      try { ro.observe(n as Element); } catch {}
    });
    const onLoadCapture = () => snapIfPinned();
    el.addEventListener('load', onLoadCapture, true);
    el.addEventListener('error', onLoadCapture, true);
    return () => {
      el.removeEventListener('load', onLoadCapture, true);
      el.removeEventListener('error', onLoadCapture, true);
      mo.disconnect();
      ro.disconnect();
    };
  });

  // ── Typing indicator push: smartly keep most recent message visible ──
  // The typing indicator now occupies layout space (flex row above the
  // input, ~28px) and shrinks the messages viewport via flex. When the
  // user is pinned at the bottom, the viewport shrink must keep the
  // last message fully visible — not clipped by the new row. The
  // ResizeObserver above already handles container-height shrinks in many
  // cases, but the typing row lives outside the observed container
  // (.bufferinputcell), so we explicitly re-snap here when typing appears.
  // Only when pinned; reading history (scrolled up) is never yanked.
  const isTypingActive = $derived.by(() => {
    void ircState.typingVersion;
    const netId = ircState.activeBuffer.networkId;
    const buf = ircState.activeBuffer.bufferName;
    if (!netId || !buf) return false;
    return getTypersForBuffer(netId, buf).length > 0;
  });
  $effect(() => {
    void isTypingActive;
    if (isServerBuffer) return;
    if (!container) return;
    if (!cachedAtBottom) return;
    // DOM has just updated with the typing row; wait a tick for flex
    // layout to settle, then snap to true bottom.
    tick().then(() => {
      if (!container || !cachedAtBottom) return;
      container.scrollTop = container.scrollHeight;
      void container.scrollHeight;
      container.scrollTop = container.scrollHeight;
      prevScrollTop = container.scrollTop;
      prevScrollHeight = container.scrollHeight;
      requestAnimationFrame(() => {
        if (container && cachedAtBottom) {
          container.scrollTop = container.scrollHeight;
          prevScrollTop = container.scrollTop;
          prevScrollHeight = container.scrollHeight;
        }
      });
    });
  });

  // ── ENTERPRISE INVARIANT: windowing $effect ───────────────────────────
  // This effect is the sole writer of renderStart/renderEndKey/cachedAtBottom/
  // wasRecentlyAtBottom during normal message flow. Svelte 5 tracks any $state
  // read inside $effect — a direct read + write of the same signal re-queues
  // the effect synchronously and hits effect_update_depth_exceeded at 10k+ msgs
  // (batch.js:1043, MessageList:1194). Every read of those four signals inside
  // this effect MUST be via untrack(() => signal); writes MUST be via
  // untrack(()=>{ signal = ... }) so the write does not re-trigger via a
  // tracked read. The only intentional triggers are bufferKey and
  // processedMessages (read outside untrack). Guard enforced by
  // frontend/scripts/check-effect-loops.mjs in CI. See skill://svelte5-effect-loop-discipline
  $effect(() => {
    if (windowRevealInProgress) return;
    const key = bufferKey;
    const msgs = processedMessages;
    const isNewBuffer = key !== lastBufferKey;
    const isHistoryPrependForSnap = (() => { const firstKeySnap = msgs.length ? itemKeyOf(msgs[0]) : ''; return firstKeySnap !== lastFirstProcessedKey; })();
    if (isNewBuffer) {
      pendingInitialSnap = true;
      initialSnapDone = false;
      lastBufferKey = key;
      untrack(() => { cachedAtBottom = true; });
      untrack(() => { wasRecentlyAtBottom = true; });
      cachedAtTop = false;
      prevScrollHeight = 0;
      prevScrollTop = 0;
      handledDividerMark = '';
      // Cancel any in-flight re-snap chains from the previous
      // buffer — it would otherwise keep polling the shared container
      // while the new buffer's window is being established.
      if (pinnedResnapTimer) { clearTimeout(pinnedResnapTimer); pinnedResnapTimer = null; }
      if (pendingPollTimer) { clearTimeout(pendingPollTimer); pendingPollTimer = null; }
      // IRCCloud BufferLogView.render: open with the last batchSize=200.
      untrack(() => { renderStart = Math.max(0, msgs.length - BATCH_SIZE); });
      untrack(() => { renderEndKey = ''; });
      clockTs = null;
      lastFirstProcessedKey = msgs.length ? itemKeyOf(msgs[0]) : '';
      lastProcessedLength = msgs.length;
    } else {
      const firstKey = msgs.length ? itemKeyOf(msgs[0]) : '';
      if (firstKey !== lastFirstProcessedKey) {
        if (lastFirstProcessedKey === '') {
          // Buffer content arrived (initial history load): window the tail.
          untrack(() => { renderStart = Math.max(0, msgs.length - BATCH_SIZE); });
          // Cold-start: messages arrived after the buffer was already active
          // but empty (first URL load, no cache). The initial mount's
          // pendingInitialSnap was already consumed for the empty state, so
          // force a new one to ensure we land at the very bottom.
          pendingInitialSnap = true;
          initialSnapDone = false;
          untrack(() => { cachedAtBottom = true; });
          cachedAtTop = false;
        } else {
          const rawOldH = container ? container.scrollHeight : 0;
          const rawOldTop = container ? container.scrollTop : 0;
          const usePrev = prevScrollHeight !== 0 && prevScrollTop !== 0 && Math.abs(rawOldH - prevScrollHeight) > 500;
          const oldScrollHeight = usePrev ? prevScrollHeight : rawOldH;
          const oldScrollTop = usePrev ? prevScrollTop : rawOldTop;
          const atTopBefore = oldScrollTop <= 0;
          const idx = msgs.findIndex(m => itemKeyOf(m) === lastFirstProcessedKey);
          const scrollBottomBefore = container ? container.clientHeight + Math.ceil(oldScrollTop) : 0;
          const pinBottomBefore = oldScrollHeight - scrollBottomBefore <= 1;
          if ((pendingInitialSnap && untrack(() => cachedAtBottom)) || pinBottomBefore) {
            // Still in the initial snap window (first URL load). Keep the
            // window pinned to the tail so we stay at the very bottom when
            // loadHistory prepends the remaining backlog right after the
            // initial sync. Without this, the idx>0 path would keep the
            // viewport anchored mid-history (Super%20Nets first load).
            untrack(() => { renderStart = Math.max(0, msgs.length - BATCH_SIZE); });
            // If we were physically at bottom before the prepend (pinBottomBefore),
            // keep pinned at bottom even if shouldSnap is false due to
            // isAtBottom being stale. This fixes double-load flash where
            // second history batch arrives while still at bottom but
            // cachedAtBottom was cleared by a stray scroll event.
            if (pinBottomBefore && container) {
              tick().then(() => {
                if (container) container.scrollTop = container.scrollHeight;
              });
            }
          } else if (idx > 0) {
            const start = untrack(() => renderStart);
            if (start > 0) untrack(() => { renderStart = start + idx; });
            // start==0 (fully rendered, at top of backlog): keep renderStart 0
            // so the new older rows become visible above the divider.
            // The mid-buffer anchor below keeps the viewport stable if the
          } else if (idx < 0) {
            // Head key vanished — the first processed row changed identity
            // (e.g. a backlog fetch merged JOINs into the head
            // JOINPART_GROUP, changing the group's first event and therefore
            // its key; or an optimistic echo replaced the head in place).
            // In every such case the old head is STILL the first processed
            // entry — it merged or was replaced in place — so renderStart
            // must stay put. NEVER reset to the tail here: that yanks the
            // user from old history down to the newest messages ("scrolling
            // up forces me back down").
          }
          // Anchor scroll after the window shift so the viewport stays on
          // !pinBottom) we compensate manually with scrollTop += delta
          // (IRCCloud fetched() does the same). If the browser's native
          // scroll anchoring also adjusted scrollTop during the render,
          // the write is idempotent (both shift by the same prepended
          // height); if it didn't, this is the only compensation. delta is
          // measured from the DOM after the render, so a re-keyed head
          // group that merges without growing the row count (delta 0)
          // needs no compensation.
          if (container && !atTopBefore && !pinBottomBefore) {
            const c = container;
            const oldH = oldScrollHeight;
            const oldTop = oldScrollTop;
            let didFlush = true;
            try { flushSync(); } catch { didFlush = false; }
            const doDelta = () => {
              const delta = c.scrollHeight - oldH;
              if (delta !== 0) c.scrollTop = oldTop + delta;
            };
            if (didFlush) doDelta();
            else tick().then(doDelta);
          }
        }
      } else {
        // Append-only burst: head unchanged, tail grew. Keep window bounded
        // so 1000-msg burst stays at 150-250 DOM rows instead of 350+ before
        // maybeTrim. Only while pinned and not frozen (reading history).
        // Guard on length increase: window reveals (renderStart moved via
        // revealBacklogFromMemory) do not increase len but would otherwise
        // satisfy neededStart>start and be yanked back to tail.
        const start = untrack(() => renderStart);
        const neededStart = Math.max(0, msgs.length - BATCH_SIZE);
        if (neededStart > start && untrack(() => cachedAtBottom) && !untrack(() => renderEndKey) && msgs.length > lastProcessedLength && !windowRevealInProgress) {
          untrack(() => { renderStart = neededStart; });
        }
      }
      lastFirstProcessedKey = firstKey;
      lastProcessedLength = msgs.length;
    }

    if (!container) return;
    const mark = untrack(() => backlogDividerMark);
    const newDivider = mark !== '' && mark !== handledDividerMark;
    handledDividerMark = mark;

    // Refresh-not-at-bottom fix: a freshly-opened buffer (first mount
    // after a page reload) must always land at the very bottom, even
    // if a stray scroll event cleared cachedAtBottom between the
    // renderStart assignment and this snap check.  pendingInitialSnap
    // survives the `if (!container) return` gap on first mount and
    // forces one unconditional snap. It is kept until we have messages
    // to snap to — a buffer that mounts empty (pre-sync, e.g. first
    // login with no cache) must NOT consume the flag with 0 messages,
    // otherwise the subsequent sync-payload arrival runs as a normal
    // pinned check and a scrollTop=0 event from the incoming
    // scrollHeight growth can clear cachedAtBottom and leave the user
    // stranded mid-history (first-login midway bug). See
    // MessageList.refresh.test.ts async arrival case.
    const hasMessagesForInitialSnap = processedMessages.length > 0;
    const isInitialSnap = pendingInitialSnap && hasMessagesForInitialSnap;
    const isDomAtBottom = !container || container.scrollHeight <= container.clientHeight + 1 || Math.abs(container.scrollHeight - container.scrollTop - container.clientHeight) <= 1;
    // IRCCloud BufferScrollView.flushBuffer uses strict isScrolledToBottom() (1px, no wasRecently)
    // to decide whether to buffer incoming messages while reading. wasRecently (100ms grace)
    // is only for textarea autogrow, not for message pin. Using wasRecently here caused
    // "if a new message comes in it forces it to bottom" — any message arriving within
    // 100ms of scrolling up was considered pinned via wasRecently and snapped. See
    // bufferscrollview.js flushBuffer vs shouldPinBottom.
    const isAtBottomStrict = untrack(() => cachedAtBottom) || isDomAtBottom;
    const isAtBottom = isAtBottomStrict;
    // isHistoryPrependForSnap previously forced a snap even when reading.
    // Gate on isAtBottom so only pinned fills snap; initial load isAtBottom true.
    const historyPrependSnap = isInitialSnap && isHistoryPrependForSnap && isAtBottom;
    // When a backlog divider is present and user is at top (reading history),
    // never snap to bottom – preserve via newDivider branch (oldTop+delta).
    // This fixes "scroll all the way to start without being forced to bottom".
    // NOTE: previously `lastIsActionNotice` forced a snap for any trailing
    // ACTION/NOTICE even while scrolled up reading history ("if a new message
    // comes in it forces it to bottom"). IRCCloud's BufferLogView.renderMessage
    // still respects shouldPinBottom for NOTICEs/actions — they buffer when
    // scrolled up. So we do NOT auto-pin on message type; only on pin state.
    const shouldSnapToBottom = !isServerBuffer && hasMessagesForInitialSnap && (isAtBottom || historyPrependSnap) && !(newDivider && cachedAtTop);
    if (shouldSnapToBottom) {
      // If DOM is at bottom but cached state is stale, correct it so future
      // handleScroll checks see the right baseline and don't mis-fire scrolledUp.
      if (isDomAtBottom) untrack(() => { cachedAtBottom = true; });
      // For an initial buffer open we force the snap unconditionally —
      // do not run the scrolledUp direction check that would otherwise
      // clear the stick when scrollHeight grew under a pinned viewport.
      if (!isInitialSnap) {
        const scrolledUp = container ? container.scrollTop < prevScrollTop : false;
        if (scrolledUp) { untrack(() => { cachedAtBottom = false; wasRecentlyAtBottom = false; }); if (recentlyScrolledTimeout) { clearTimeout(recentlyScrolledTimeout); recentlyScrolledTimeout = null; } } else {
          untrack(() => { renderEndKey = ''; });
          untrack(() => { wasRecentlyAtBottom = true; });
          if (recentlyScrolledTimeout) { clearTimeout(recentlyScrolledTimeout); recentlyScrolledTimeout = null; }
          tick().then(() => {
            if (!container) return;
            // Entrance animation: detect which messages are new since the last
            // time we were at the bottom. Only the batch head (firstAuthor or
            // non-grouped rows) gets the full slide-in; sameAuthor rows get a
            // subtler fade via CSS (.messageEntrance.sameAuthor).
            const allMsgs = processedMessages;
            if (allMsgs.length > 0) {
              const lastKey = itemKeyOf(allMsgs[allMsgs.length - 1]);
              if (lastKey !== lastBottomKey) {
                if (lastBottomKey) {
                  let foundBoundary = false;
                  let prevWasEntrance = false;
                  const newKeys = new Set<string>();
                  for (let i = allMsgs.length - 1; i >= 0; i--) {
                    const key = itemKeyOf(allMsgs[i]);
                    if (key === lastBottomKey) break;
                    const msg = allMsgs[i];
                    const isGroupHead = msg.command !== 'PRIVMSG' && msg.type !== 'action'
                      || (i > 0 && !checkSameAuthor(msg, allMsgs, i));
                    if (!foundBoundary || isGroupHead) {
                      newKeys.add(key);
                      foundBoundary = true;
                    }
                  }
                  if (newKeys.size > 0) {
                    entranceKeys = newKeys;
                    scheduleEntranceCleanup();
                  }
                }
                lastBottomKey = lastKey;
              }
            }
            container.scrollTop = container.scrollHeight;
            void container.scrollHeight;
            container.scrollTop = container.scrollHeight;
            cachedAtTop = false;
            requestAnimationFrame(() => {
              if (cachedAtBottom && container) {
                container.scrollTop = container.scrollHeight;
              }
            });
            schedulePinnedResnap();
          });
        }
      } else if (cachedAtTop && container && container.scrollHeight - container.scrollTop - container.clientHeight > STICK_BAND_PX) {
        // The user has scrolled UP to read older history inside the
        // initial-snap window (first 5s after opening the buffer): never
        // force the viewport back to the bottom. That unconditional pin is
        // what made the scrollbar jump down right after a history load
        // ("it keeps forcing the scroll bar down each time it loads
        // messages"). The viewport stays where the user put it.
        // On a short log the pinned-bottom position can sit inside the
        // 200px at-top band, so cachedAtTop alone cannot distinguish
        // "pinned at the bottom" from "scrolled up to read history".
        // Use the physical distance from the bottom: pinned = within the
        // stick band (<=70px, e.g. the just-appended row's height);
        // scrolled up to read older chat = far from the bottom. Only the
        // latter skips the unconditional initial-snap pin — and still
        // preserves the reading position across the prepend.
        pendingInitialSnap = false;
        initialSnapDone = true;
        preserveReadingPosition(container, prevScrollTop);
      } else {
        // Initial snap for a freshly-opened buffer (refresh): unconditional.
        untrack(() => { renderEndKey = ''; });
        maybeTrim();
        tick().then(() => {
          if (!container) return;
          const allMsgs2 = processedMessages;
          if (allMsgs2.length > 0) {
            const lastKey2 = itemKeyOf(allMsgs2[allMsgs2.length - 1]);
            if (lastKey2 !== lastBottomKey) {
              lastBottomKey = lastKey2;
            }
          }
          const doSnap = () => {
            if (!container) return;
            container.scrollTop = container.scrollHeight;
            void container.scrollHeight;
            container.scrollTop = container.scrollHeight;
          };
          doSnap();
          cachedAtBottom = true;
          cachedAtTop = false;
          requestAnimationFrame(() => {
            doSnap();
            if (container && container.scrollHeight - container.clientHeight - container.scrollTop > 2) {
              doSnap();
            }
            schedulePinnedResnap(40);
            requestAnimationFrame(() => { initialSnapDone = true; });
          });
        });
      }
      // Clear pendingInitialSnap: keep it for 2s after an initial snap so
      // rapid successive prepends (loadHistory right after sync) still see
      // isInitialSnap true and stay pinned to bottom. Normal pinned snaps
      // clear immediately.
      if (isInitialSnap) {
        setTimeout(() => { pendingInitialSnap = false; }, 5000);
      } else if (hasMessagesForInitialSnap) {
        pendingInitialSnap = false;
      }
    } else if (newDivider && cachedAtTop) {
      // IRCCloud fetched() half-way scroll: divider at 152px from top (min 48), not exact anchor.
      // This is the "constantly scrolling up" feel – each top-hit leaves 152px of older history
      // visible above the divider, so the next wheel-up immediately hits top again.
      // Matches common-5650bddb.js: var a=Math.round(r.position().top);this.scrollTo(a-31),this.scrollTo(Math.max(a-152,48),{animate:!0})
      const divider = container.querySelector('.backlogDivider') as HTMLElement | null;
      if (divider) {
        const a = Math.round(dividerPos(divider));
        container.scrollTop = a - 31;
        const target = Math.max(a - 152, 48);
        animateScrollTo(container, target, 100);
      } else {
        preserveReadingPosition(container, prevScrollTop);
      }
      prevScrollTop = container.scrollTop;
      prevScrollHeight = container.scrollHeight;
      cachedAtTop = container.scrollTop <= 0;
      cachedAtBottom = false;
      wasRecentlyAtBottom = false;
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

    // Non-scrollable guard: when the content fits without a scrollbar, the user
    // is effectively at the bottom by definition. A stray 1px scrollUp that
    // cleared cachedAtBottom must not keep new messages buffered forever with
    // no scroll event to re-engage. Force pinned state and clear any frozen window.
    if (container.scrollHeight <= container.clientHeight + 1) {
      if (!cachedAtBottom) {
        cachedAtBottom = true;
        wasRecentlyAtBottom = true;
        renderEndKey = '';
        maybeTrim();
      }
      cachedAtTop = container.scrollTop <= 0;
      prevScrollTop = container.scrollTop;
      prevScrollHeight = container.scrollHeight;
      scheduleScrollStateUpdate();
      return;
    }

    const scrollTop = container.scrollTop;
    const scrollHeight = container.scrollHeight;
    const prevHeight = prevScrollHeight;
    if (prevScrollTop === scrollTop && prevHeight === scrollHeight) return;
    // Capture the previous event's scrollTop BEFORE updating prevScrollTop —
    // used to detect actual downward movement for the stick re-engagement
    // band below (stick-to-bottom-svelte's isScrollingDown).
    const prevTop = prevScrollTop;
    prevScrollTop = scrollTop;
    prevScrollHeight = scrollHeight;
    // IRCCloud isScrolledToTop(): user is at the very top of the container.
    // IRCCloud checks scrollTop===0 exact, not a 200px band. Only fire
    // when truly at top (0), not 200px before, to get the single-batch
    // per top-hit cadence.
    cachedAtTop = scrollTop <= 0;
    // IRCCloud isScrolledToBottom(true): when already pinned, use a strict
    // 0px check — any intentional scroll-up (even 1px on a trackpad) must
    // clear cachedAtBottom immediately, otherwise the ResizeObserver and
    // schedulePinnedResnap keep fighting the user. Per ChatInfinite.atBottomStickiness
    // upward movement inside the 70px band must disengage — reading 50px up
    // is never yanked back (Controller.lean atBottomStickiness.2).
    // When NOT pinned (stick broken by a scroll-up), re-engage only on an
    // actual DOWNWARD scroll into the near-bottom band — a stopped position
    // within the band does NOT re-stick (reading is never yanked).
    const scrollBottom = container.clientHeight + Math.ceil(scrollTop);
    const distFromBottom = scrollHeight - scrollBottom;
    const scrolledUp = scrollTop < prevTop && scrollHeight >= prevHeight;
    const scrolledDown = scrollTop > prevTop && scrollHeight >= prevHeight;
    const heightChangedWithoutScroll = scrollHeight !== prevHeight && scrollTop === prevTop;
    // During the initial snap window (pendingInitialSnap), height growth
    // without scroll is expected as history fills in — don't treat the huge
    // distFromBottom as leaving the bottom. But only while still pinned at
    // bottom (cachedAtBottom true) — when user is reading at top (cachedAtTop
    // true, cachedAtBottom false) a height growth from "Fetching..." must
    // NOT keep the bottom stick, otherwise ResizeObserver will yank to bottom.
    // IRCCloud BufferScrollView.shouldPinBottom() is strict 1px (no band);
    // our STICK_BAND_PX 70px re-engages only on an actual DOWNWARD scroll
    // into the band — a stopped position within the band does NOT re-stick
    // (reading 50px up is never yanked back). See bufferscrollview.js
    // shouldPinBottom + ChatInfinite.atBottomStickiness.
    const atBottom = scrolledUp
      ? false
      : scrollHeight < prevHeight && cachedAtBottom
        ? true
        : pendingInitialSnap && heightChangedWithoutScroll && cachedAtBottom && !cachedAtTop
          ? true
          : cachedAtBottom && !cachedAtTop
            ? heightChangedWithoutScroll ? true : distFromBottom <= 1
            : scrolledDown ? distFromBottom <= STICK_BAND_PX : false;
    if (cachedAtBottom === atBottom) {
      // Still at bottom or still not at bottom — just update auxiliary state (rAF-batched)
      scheduleScrollStateUpdate();
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
        // Unlock bottomSeen — user has returned to live stream, so the
        // "New messages since you scrolled up" divider should disappear.
        // Mirrors BufferScrollView.unlockBottomSeen / buf.js unlockBottomSeen.
        {
          const nid = ircState.activeBuffer.networkId;
          const buf = ircState.activeBuffer.bufferName;
          if (nid && buf) clearBottomSeen(nid, buf);
        }
        // Band re-engagement: the stick was broken (user scrolled up) and
        // they scrolled back DOWN into the near-bottom band — that means
        // "return to the live stream", so snap to the bottom NOW. This
        // keeps the latched state unambiguous ("latched" ≡ "at the
        // bottom"); without the snap, a 30px-offset latch would be
        // misread as pinned-drift by the poll/RO and re-yanked, and its
        // stale baseline would misfire the effect's scrolledUp check on
        // the next message.
        if (container.scrollHeight - container.clientHeight - container.scrollTop > 0) {
          container.scrollTop = container.scrollHeight;
          prevScrollTop = container.scrollTop;
          prevScrollHeight = container.scrollHeight;
        }
        // Force true bottom after trim's DOM update (tick+rAF) and schedule resnap
        // to catch any late layout growth — fixes 25px short after return
        tick().then(() => {
          if (container && cachedAtBottom) {
            container.scrollTop = container.scrollHeight;
            prevScrollTop = container.scrollTop;
            prevScrollHeight = container.scrollHeight;
            requestAnimationFrame(() => {
              if (container && cachedAtBottom) {
                container.scrollTop = container.scrollHeight;
                prevScrollTop = container.scrollTop;
                prevScrollHeight = container.scrollHeight;
                schedulePinnedResnap();
              }
            });
          }
        });
      } else {
        // Just left bottom — 100ms grace period for autogrow-input only
        if (recentlyScrolledTimeout) clearTimeout(recentlyScrolledTimeout);
        recentlyScrolledTimeout = setTimeout(() => {
          wasRecentlyAtBottom = false;
          recentlyScrolledTimeout = null;
        }, 100);
        // Leaving bottom: cancel any pending re-snap chain so we don't
        // force a user who scrolled up 50ms after sending back to bottom.
        if (pendingPollTimer) { clearTimeout(pendingPollTimer); pendingPollTimer = null; }
        if (pinnedResnapTimer) { clearTimeout(pinnedResnapTimer); pinnedResnapTimer = null; }
        if (pendingInitialSnap && distFromBottom > 1) pendingInitialSnap = false;
        // IRCCloud bufferMessage: while scrolled up, new messages buffer
        // instead of rendering — freeze the window's end where it is now.
        const all = processedMessages;
        renderEndKey = all.length ? itemKeyOf(all[all.length - 1]) : '';
        // Lock bottomSeen to the last message at the moment you scrolled up.
        // Mirrors buf.js lockBottomSeen() which sets bottomSeen = getLastMessage().
        // This divider stays fixed until you return to bottom (unlock above),
        // so it doesn't creep forward with each new message and flicker.
        {
          const nid = ircState.activeBuffer.networkId;
          const buf = ircState.activeBuffer.bufferName;
          if (nid && buf) {
            const list = ircState.messages[`${nid}:${buf}`] ?? [];
            const last = list[list.length - 1];
            if (last?.t) setBottomSeen(nid, buf, last.t);
            else if (all.length && all[all.length - 1]?.t) setBottomSeen(nid, buf, all[all.length - 1].t!);
          }
        }
      }

      scheduleScrollStateUpdate();
    }

    // Infinite scroll is triggered by LoadMore's top sentinel
    // (IntersectionObserver with a 200px rootMargin pre-load buffer,
    // svelte-infinite pattern) instead of a scrollTop===0 check here.
    // The observer fires on layout, so it cannot wedge at scrollTop 0
    // where no scroll events fire on wheel-up.
  }

  function scheduleScrollStateUpdate(): void {
    if (import.meta.env.MODE === 'test') {
      updateScrollState();
      return;
    }
    if (scrollRafPending) return;
    scrollRafPending = true;
    requestAnimationFrame(() => {
      scrollRafPending = false;
      updateScrollState();
    });
  }

  // Attach scroll listener as passive:true (IRCCloud parity) — Svelte's
  // `onscroll` compiles to a non-passive addEventListener, so we wire it
  // manually. rAF coalescing above ensures getBoundingClientRect work
  // doesn't block the wheel.
  //
  // User scroll-INTENT pre-clear (stick-to-bottom-svelte handleWheel /
  // handlePointerDown): the pinned-snap machinery (effect bottom branch,
  // ResizeObserver, resnap polls) reads cachedAtBottom and yanks the
  // viewport to the bottom. A message landing between the user's input
  // (keydown/wheel) and the FIRST scroll event — which clears
  // cachedAtBottom via the strict check — would snap them back down
  // ("holding ArrowUp keeps resetting me back down"). Clear the stick at
  // input time, before any scroll event fires. The near-bottom band
  // re-engages it on the next downward scroll, so clearing on any wheel
  // or scroll key is safe.
  const SCROLL_KEYS = new Set(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' ', 'Spacebar']);
  $effect(() => {
    const el = container;
    if (!el) return;
    const clearStickOnUserInput = () => {
      if (pendingInitialSnap) pendingInitialSnap = false;
      if (!cachedAtBottom && !wasRecentlyAtBottom) return;
      cachedAtBottom = false;
      wasRecentlyAtBottom = false;
      if (recentlyScrolledTimeout) { clearTimeout(recentlyScrolledTimeout); recentlyScrolledTimeout = null; }
      if (pendingPollTimer) { clearTimeout(pendingPollTimer); pendingPollTimer = null; }
      if (pinnedResnapTimer) { clearTimeout(pinnedResnapTimer); pinnedResnapTimer = null; }
    };
    const onWheel = (e: WheelEvent) => {
      if (!container) return;
      const atBottom = container.scrollHeight - container.clientHeight - container.scrollTop <= 1;
      if (e.deltaY > 0 && atBottom) {
        e.preventDefault();
        return;
      }
      if (e.deltaY < 0) clearStickOnUserInput();
    };
    const onPointerDown = () => clearStickOnUserInput();
    const onKeyDown = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || (t as HTMLElement).isContentEditable)) return;
      if (SCROLL_KEYS.has(e.key)) clearStickOnUserInput();
    };
    el.addEventListener('scroll', handleScroll, { passive: true });
    el.addEventListener('wheel', onWheel, { passive: false });
    el.addEventListener('pointerdown', onPointerDown, { passive: true });
    window.addEventListener('keydown', onKeyDown, { capture: true });
    return () => {
      el.removeEventListener('scroll', handleScroll);
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown, { capture: true } as EventListenerOptions);
    };
  });

  // When a new message arrives while scrolled up, the ChatterBar below
  // should appear even though the user hasn't scrolled. Previously
  // updateChatterCounts was only called on scroll (handleScroll →
  // scheduleScrollStateUpdate), so new messages while scrolled up never
  // triggered the bar until the next scroll. This effect watches for new
  // messages and for bottomSeen changes and schedules an update when not
  // at bottom, matching IRCCloud's LowerChatterBarView.update on new
  // message while scrolled up.
  $effect(() => {
    void processedMessages.length;
    const nid = ircState.activeBuffer.networkId;
    const buf = ircState.activeBuffer.bufferName;
    void (nid && buf ? getBottomSeen(nid, buf) : null);
    const atBottom = cachedAtBottom;
    if (!atBottom) {
      scheduleScrollStateUpdate();
    }
  });

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
    if (pendingInitialSnap || cachedAtBottom || !topRow) {
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

    // Below viewport: in-window rows below the visible bottom + buffered rows beyond the frozen window.
    let below = 0;
    let belowTs: number | null = null;
    let firstBelowMsg: IRCMessage | null = null;
    const all = processedMessages;
    const endIdx = Math.max(0, Math.min(renderStart, all.length)) + rendered.length;
    const bufferedBelow = endIdx < all.length ? all.length - endIdx : 0;
    const bufferedHead: IRCMessage | null = bufferedBelow > 0 ? all[endIdx] : null;
    let inWindowBelow = 0;
    let inWindowHead: IRCMessage | null = null;
    let inWindowHeadTs: number | null = null;
    if (bottomIdx >= 0 && bottomIdx < rendered.length - 1) {
      inWindowBelow = rendered.length - 1 - bottomIdx;
      const item = rendered[bottomIdx + 1];
      inWindowHead = rawMessageByKey.get(itemKeyOf(item.msg)) ?? null;
      inWindowHeadTs = item.msg.t || null;
    }
    if (inWindowBelow > 0 && bufferedBelow > 0) {
      below = inWindowBelow + bufferedBelow;
      firstBelowMsg = inWindowHead;
      belowTs = inWindowHeadTs;
    } else if (inWindowBelow > 0) {
      below = inWindowBelow;
      firstBelowMsg = inWindowHead;
      belowTs = inWindowHeadTs;
    } else if (bufferedBelow > 0) {
      below = bufferedBelow;
      firstBelowMsg = rawMessageByKey.get(itemKeyOf(bufferedHead!)) ?? null;
      belowTs = bufferedHead!.t || null;
    } else if (bottomIdx === -1 && rendered.length > 0 && bufferedBelow === 0) {
      below = 0;
      belowTs = null;
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

    // Removed synthetic "instant ↓ bar" that forced `below=1` on any tiny scroll.
    // Previously `if (!cachedAtBottom && !firstBelowMsg)` always synthesized 1
    // hidden row even when `bufferedBelow==0` and no unread existed, so
    // scrolling up 1px while fully read showed "1 unread". Now we only show
    // the lower bar when there is a genuinely hidden row (inWindowBelow or
    // bufferedBelow). Tiny scroll with no fully-hidden row correctly shows 0.
    // IRCCloud LowerChatterBar counts messages *since you scrolled up* (locked
    // bottomSeen), not total hidden below viewport. Using firstBelow (dynamic
    // with scroll position) caused the count to flicker as you scrolled and
    // as new messages arrived. We now use the locked bottomSeen timestamp
    // set in handleScroll when you left bottom; it stays fixed until you
    // return to bottom (clearBottomSeen), so the divider and bar are stable.
    const lockedBottomTs = getBottomSeen(networkId, bufferName);
    // Only show "unread below" when you are actually scrolled up (not at bottom).
    // When you are at bottom (looking), you have seen the latest, so the bar
    // should be hidden even if bottomSeen was locked 5 minutes ago before a
    // refresh. The lock is cleared in handleScroll when you return to bottom,
    // but updateChatterCounts can run one rAF before that clear, so we gate
    // on cachedAtBottom here too to avoid a one-frame flicker.
    if (lockedBottomTs !== null && !cachedAtBottom) {
      const list = ircState.messages[`${networkId}:${bufferName}`] ?? [];
      let lockedMsg: IRCMessage | null = null;
      for (let i = list.length - 1; i >= 0; i--) {
        if ((list[i].t || 0) === lockedBottomTs) { lockedMsg = list[i]; break; }
      }
      // Fallback: if timestamp not found (clock skew), use firstBelow as before
      if (!lockedMsg) lockedMsg = firstBelowMsg;
      if (lockedMsg) {
        // Count only messages not from self — you already saw your own
        // echo (it was typed at top of input), so it shouldn't trigger
        // "New messages since you scrolled up" or the ChatterBar.
        const myNickLower = (activeNetwork?.currentNick || '').toLowerCase();
        const listForCount = ircState.messages[`${networkId}:${bufferName}`] ?? [];
        const startIdx = listForCount.findIndex(m => m === lockedMsg);
        let filteredTotal = 0;
        let filteredImportant = 0;
        if (startIdx >= 0) {
          for (let i = startIdx + 1; i < listForCount.length; i++) {
            const m = listForCount[i];
            if (!m.text || !m.nick) continue;
            if (stripPrefix(m.nick).toLowerCase() === myNickLower) continue;
            const isChat = m.command === 'PRIVMSG' || (m.command === 'NOTICE' && !!m.nick);
            if (!isChat) continue;
            // Also check if message is actually unseen (t > lastSeen) — but
            // new messages since lock are all t > lockedMsg.t, and lockedMsg.t
            // is at or before lastSeen? For now, count all not-from-self after lock.
            filteredTotal++;
            // isImportantMessage is not exported, use countImportant logic inline
            if (m.command === 'PRIVMSG' || m.type === 'action') filteredImportant++;
          }
        } else {
          // Fallback: use original counts if lockedMsg not found in list
          filteredTotal = countMessagesBetween(networkId, bufferName, lockedMsg);
          filteredImportant = countImportantMessagesBetween(networkId, bufferName, lockedMsg);
        }
        if (filteredTotal === 0) {
          belowUnseenCount = 0;
          belowUnseenTimestamp = null;
          belowUnseenHighlights = 0;
        } else if (filteredTotal > 100) {
          belowUnseenCount = filteredTotal;
          belowUnseenTimestamp = lockedMsg.t || null;
          belowUnseenHighlights = unseenHighlightCountAfter(networkId, bufferName, lockedMsg);
        } else {
          // For <=100, show filtered total (or important if you prefer)
          belowUnseenCount = filteredTotal;
          belowUnseenTimestamp = lockedMsg.t || null;
          belowUnseenHighlights = unseenHighlightCountAfter(networkId, bufferName, lockedMsg);
        }
      } else {
        belowUnseenCount = 0;
        belowUnseenTimestamp = null;
        belowUnseenHighlights = 0;
      }
    } else {
      belowUnseenCount = 0;
      belowUnseenTimestamp = null;
      belowUnseenHighlights = 0;
    }
  }

  function updateReadTracking(rect: DOMRect, bottomRow: HTMLElement | null): void {
    const { networkId, bufferName } = ircState.activeBuffer;
    if (!networkId || !bufferName || !bottomRow) return;
    // Only update lastSeen when actually at the bottom (have read the latest).
    // Updating on every scroll while scrolled up would move the "New messages"
    // divider as you scroll, causing it to follow you instead of staying at
    // the original unread point (IRCCloud: setLastSeen only on read/deselect,
    // not on every scroll). Matches BufferView.showSeenMarker priority.
    if (!cachedAtBottom) return;
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
    // Only mark as read if the bottom visible is the actual last message in the buffer
    // (i.e., you are at the true bottom, not just at the bottom of the windowed view)
    const all = ircState.messages[`${networkId}:${bufferName}`] ?? [];
    if (all.length > 0 && raw && (all[all.length - 1].eid !== raw.eid && all[all.length - 1].msgid !== raw.msgid)) {
      // Bottom visible is not the true last message (windowed view), don't update lastSeen
      // This prevents lastSeen from moving when you are at the bottom of the windowed view
      // but not at the true bottom of the buffer (e.g., when renderStart > 0 and you are at bottom of window)
      return;
    }
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
    // svelte-ignore non_reactive_update
    if (stickyAvatarEl) stickyAvatarEl.style.top = `${top}px`;
  }

  // IRCCloud: while scrolled up, new messages are buffered (renderEndKey frozen)
  $effect(() => {
    const len = processedMessages.length;
    const frozen = renderEndKey !== '';
    void len; void frozen;
    if (frozen && container) {
      scheduleScrollStateUpdate();
    }
  });

  function scrollToTop(): void {
    // Clicking the "N unread above" bar means you are going to see those
    // messages, so mark them as read immediately (don't wait for the smooth
    // scroll to finish and handleScroll to fire). This prevents the bar
    // from staying visible after you clicked it and it scrolled to top.
    const nid = ircState.activeBuffer.networkId;
    const buf = ircState.activeBuffer.bufferName;
    if (nid && buf) {
      aboveUnseenCount = 0;
      aboveUnseenTimestamp = null;
      aboveUnseenHighlights = 0;
    }
    container?.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function scrollToBottom(): void {
    if (!container) return;
    // Clicking the "N unread below" bar (e.g. "1 unread (less than a minute)")
    // should immediately mark those new messages as read and hide the bar.
    // Previously it only scrolled, and relied on handleScroll's atBottom
    // detection after the smooth scroll finished (rAF + 200ms), so the bar
    // stayed visible for a moment after you clicked and it scrolled.
    const nid = ircState.activeBuffer.networkId;
    const buf = ircState.activeBuffer.bufferName;
    if (nid && buf) {
      const list = ircState.messages[`${nid}:${buf}`] ?? [];
      if (list.length > 0) {
        const last = list[list.length - 1];
        if (last.t) {
          setLastSeen(nid, buf, last.t);
          clearBottomSeen(nid, buf);
          // Also clear the buffer's lastSeen for consistency
          const net = getActiveNetwork();
          const b = net?.buffers.find(x => x.name === buf);
          if (b) {
            b.lastSeen = last.t;
            b.bottomSeen = last.t;
          }
        }
      }
      belowUnseenCount = 0;
      belowUnseenTimestamp = null;
      belowUnseenHighlights = 0;
      // Also clear the divider's bottomSeen so it doesn't reappear
      // on the next updateChatterCounts tick before handleScroll clears.
    }
    if (renderEndKey) {
      renderEndKey = '';
      maybeTrim();
      try { flushSync(); } catch {}
    }
    cachedAtBottom = true;
    wasRecentlyAtBottom = true;
    if (recentlyScrolledTimeout) {
      clearTimeout(recentlyScrolledTimeout);
      recentlyScrolledTimeout = null;
    }
    container.scrollTo({ top: container.scrollHeight, behavior: 'smooth' });
  }
</script>

{#if aboveUnseenCount > 0}
  <ChatterBar position="above" count={aboveUnseenCount} timestamp={aboveUnseenTimestamp} mentions={aboveUnseenHighlights} onClick={scrollToTop} />
{/if}

<div class="messages-viewport" class:clockShown={clockTs !== null}>
  <div class="messages" id="messages" bind:this={container} onscroll={handleScroll}>
    {#if import.meta.env.MODE !== 'test' && InfiniteLoader && loaderState}
      <InfiniteLoader {loaderState} triggerLoad={infiniteHandler} intersectionOptions={infiniteOptions}>
        {#snippet children()}
        {/snippet}
        {#snippet loading()}
          <div class="row fetch" role="status" aria-label="Loading history">
            <hr />
            <h4 class="divider-text-wrapper"><span class="divider-text">Fetching more history…</span></h4>
          </div>
        {/snippet}
        {#snippet noData()}
        {/snippet}
        {#snippet noResults()}
        {/snippet}
        {#snippet error(load)}
          <div class="row fetch" role="alert">
            <p class="divider-text">Failed to load history</p>
            <button class="history-loading__retry" onclick={load}>Retry</button>
          </div>
        {/snippet}
      </InfiniteLoader>
    {:else}
      <LoadMore {onLoadMore} onRevealFromMemory={revealBacklogFromMemory} />
    {/if}

    {#if !hasHistoryLoaded && !isServerBuffer}
        <div class="history-loading" role="status" aria-label="Loading history">
          <div class="history-loading__spinner" aria-hidden="true"></div>
          <p class="history-loading__text">Loading history…</p>
        </div>
    {:else if messagesWithDates.length === 0 && !isServerBuffer}
        <div class="empty-channel" role="presentation">
          {#if ircState.activeBuffer.bufferName?.startsWith('#')}
            <p class="empty-headline">#{stripHash(ircState.activeBuffer.bufferName || '')}</p>
            <p class="empty-sub">No messages yet — type below to say something.</p>
          {:else}
            <p class="empty-headline">No messages with {ircState.activeBuffer.bufferName || 'this user'} yet</p>
          {/if}
        </div>
    {/if}

    {#if isServerBuffer}
      <!-- Server log view: connection attempts as collapsible cards.
           Same scroll container so the existing scroll-tracking logic
           (ChatterBar, ScrollClock, bottomSeen) keeps working. -->
      <ServerLogTimeline messages={rawMessages} network={activeNetwork} />
    {:else}
      {#each messagesWithDates as item, idx (item._key)}
        {@const msg = item.msg}
        {@const msgDate = item.msgDate}
        {@const prevDate = item.prevDate}
        {@const prevMsg = item.prevMsg}
        {@const dividerType = seenDividerByKey.get(item._key) ?? null}
        {#if item.showDate}
          <DateChange date={msgDate} />
        {/if}

        {#if item.showBacklogDivider}
          <div class="row backlogDivider"><hr /></div>
        {/if}

        {#if dividerType}
          <SeenDivider type={dividerType} networkId={ircState.activeBuffer.networkId!} bufferName={ircState.activeBuffer.bufferName!} msg={msg} prevMsg={prevMsg} sameAuthor={!!prevMsg && checkSameAuthor(msg, prevMsg)} />
        {/if}

        {#if !isSkippedCommand(msg.command)}
          <MessageRow
            {msg}
            isHighlight={msg.highlight ?? false}
            isSameAuthor={checkSameAuthor(msg, messagesWithDates.map(x=>x.msg), idx)}
            isEntrance={entranceKeys.has(itemKeyOf(msg))}
            {onNickClick}
            {memberByNick}
          />
        {/if}
      {/each}
    {/if}
  </div>

  {#if stickyNick && !isServerBuffer}
    <!-- Sticky avatar is a chat-buffer affordance (IRCCloud parity: the
         sender's letter avatar pins to the top of the viewport as you
         scroll). It must NOT render in the server log view — server-log
         rows have no nicks / no author concept, so showing a colored
         circle next to a "Connection attempt" header reads as a leak from
         a previous channel and confuses the user. -->
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
    overscroll-behavior: none;
  }
  .messages {
    overflow-y: auto;
    overflow-x: hidden;
    flex: 1;
    overscroll-behavior: none;
    scrollbar-gutter: stable;
    transition: opacity 80ms ease;
    /* Step 4b: harden window — keep 200-row DOM (renderStart/renderEndKey slice) but let browser skip offscreen layout. */
    contain: layout paint;
  }
  .messages.hide-until-snap {
    opacity: 0;
  }
  /* IRCCloud .clockShown: original IRCCloud pads loadMore/fetch by 30px so
     the floating clock doesn't cover them. That padding changes
     scrollHeight by 30px, which toggles distFromBottom across the
     cachedAtBottom exit threshold (4px) and flickers the clock when
     scrolling down into the 70px stick band (60→30→60 loop). Fiber's
     ScrollClock is pointer-events:none and overlays without needing
     layout push — keep it non-affecting. */
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
     * smoothness of the original IRCCloud client.
     * Kept at 30ms (vs IRCCloud's none) because Fiber's rAF-batched
     * updateScrollState coalesces layout reads, so the avatar
     * would otherwise lag one frame on fast fling on 120Hz displays. */
    transition: top 30ms linear;
    will-change: top;
  }
  @media (prefers-reduced-motion: reduce) {
    .stickyAvatar { transition: none; }
  }
  /* Collapse the svelte-infinite loader's empty intersection target to a
     1px sentinel (IRCCloud parity): the library's default padding-block
     leaves a permanent ~64px empty band above the first message. The
     fetch/error rows render with their own styles when active. */
  :global(.messages-viewport .messages .infinite-loader-wrapper .infinite-intersection-target) {
    min-height: 1px;
    padding-block: 0;
    display: block;
  }
  /* IRCCloud fetch divider: line with centered text chip (matches the
     LoadMore component's row.fetch). */
  .row.fetch {
    position: relative;
    text-align: center;
    padding: 8px 0;
    margin: 0;
  }
  .row.fetch hr {
    border: none;
    border-top: 1px solid var(--accent, #1e72ff);
    margin: 0;
    position: absolute;
    left: 16px;
    right: 16px;
    top: 50%;
  }
  .row.fetch .history-loading__retry {
    position: relative;
    z-index: 1;
    background: var(--chat-bg, #0e131a);
    border: 1px solid var(--accent, #1e72ff);
    color: var(--accent, #1e72ff);
    border-radius: 4px;
    padding: 2px 10px;
    font-size: 11px;
    cursor: pointer;
    margin-left: 6px;
  }
  .empty-channel {
    margin: auto;
    padding: 64px 24px;
    text-align: center;
    color: #8b949e;
    pointer-events: none;
  }
  .history-loading {
    margin: auto;
    padding: 64px 24px;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 12px;
    color: #8b949e;
    pointer-events: none;
  }
  .history-loading__spinner {
    width: 28px;
    height: 28px;
    border: 2.5px solid #21262d;
    border-top-color: #58a6ff;
    border-radius: 50%;
    animation: msg-loading-spin 0.8s linear infinite;
  }
  .history-loading__text {
    margin: 0;
    font-size: 13px;
    color: #8b949e;
  }
  .empty-loading {
    margin: auto;
    padding: 64px 24px;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 12px;
    color: #8b949e;
  }
  .empty-loading__ring {
    width: 28px;
    height: 28px;
    border: 2.5px solid #21262d;
    border-top-color: #58a6ff;
    border-radius: 50%;
    animation: msg-loading-spin 0.8s linear infinite;
  }
  @keyframes msg-loading-spin {
    to { transform: rotate(360deg); }
  }
  .empty-loading__text {
    margin: 0;
    font-size: 13px;
    color: #8b949e;
  }
  .empty-headline {
    margin: 0 0 6px;
    font: 600 18px/24px "Source Sans Pro", sans-serif;
    color: #d1d5db;
  }
  .empty-sub { margin: 0; font-size: 14px; line-height: 20px; }
  @media (max-width: 800px) {
    .empty-channel { padding: 32px 16px; }
    .empty-headline { font-size: 16px; }
  }
  /* Step 4b per-row: isolate layout to let browser skip offscreen work.
     content-visibility: auto removed — it caused scrollHeight estimation
     (contain-intrinsic-size 48px) to break IRCCloud-parity scroll pinning
     (maybeTrim pixel guard, dividerPos anchoring, MessageList.test.ts).
     contain: layout alone still reduces style recalc without affecting
     scroll metrics. Re-evaluate content-visibility only with a virtualizer
     that measures intrinsic size per row. */
  :global(.messages .row) {
    contain: layout;
  }
</style>
