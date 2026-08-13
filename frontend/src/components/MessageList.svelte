<script lang="ts">
  import { untrack, flushSync } from 'svelte';
  import { ircState, getActiveBufferObj, getActiveNetwork, isMessageUnseen, getLastSeenMessage, countMessagesBetween, countImportantMessagesBetween, clearUnseenHighlightsAfter, unseenHighlightCountAfter, updateBottomSeen, setBacklogDivider } from '../stores/ircStore.svelte';
  import { getClearedAt, setLastSeen, getBufferPrefs } from '../stores/preferences.svelte';
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
  import { dividerPos as sharedDividerPos } from '../lib/scroll';
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
  let cachedAtBottom = true;
  let wasRecentlyAtBottom = true;
  let recentlyScrolledTimeout: ReturnType<typeof setTimeout> | null = null;
  // Pending unconditional snap for a freshly-opened buffer. Set when the
  // bufferKey changes but the container is not yet bound (first mount
  // after a refresh) so the normal `if (!container) return` early-exit
  // doesn't swallow the initial bottom snap. Cleared on the next run
  // once the container exists and we have snapped.
  let pendingInitialSnap = false;
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
    if (msg.command !== 'PRIVMSG') return false;
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
        if (cand.command === 'PRIVMSG' && cand.type !== 'action') { prev = cand; break; }
        if (JOIN_PART_COMMANDS.has(cand.command)) continue;
        if (cand.command === 'MOTD_GROUP' || /^\d{3}$/.test(cand.command)) continue;
        continue;
      }
      if (!prev) return false;
    } else {
      prev = prevOrMessages as IRCMessage | null;
      if (!prev) return false;
      if (prev.type === 'action') return false;
      if (prev.command !== 'PRIVMSG') return false;
    }
    const prevNick = stripPrefix(prev.nick || '');
    if (!prevNick || prevNick !== nick) return false;
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
  // stick-to-bottom-svelte's STICK_TO_BOTTOM_OFFSET_PX: after the user
  // scrolls up (breaking the stick), a DOWNWARD scroll into this band
  // re-engages the bottom-stick. A stopped position within the band does
  // NOT re-engage — reading 50px up is never yanked.
  const STICK_BAND_PX = 70;
  let renderStart = $state(0);

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
      renderStart = Math.max(0, len - keep);
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
        // The browser's native scroll anchoring (overflow-anchor is NOT
        // disabled) already kept the boundary message at the top of the
        // viewport when the chunk was prepended — scrollTop grew by the
        // prepended height. Deliberately do NOT override it with a
        // divider-position snap: that shifted the user's content down
        // ~60px at every chunk boundary ("holding ArrowUp keeps resetting
        // me back down"). The divider slides into view as the user scrolls
        // up through the new batch.
        //
        // The 260px floor keeps the viewport OUT of LoadMore's 200px
        // pre-load band (rootMargin): if the chunk is tiny (near memory
        // exhaustion), the anchored scrollTop stays inside the band and
        // the sentinel would keep intersecting — no IO transition, no next
        // chunk, and wheel-up at scrollTop 0 fires no scroll events.
        // Landing at ≥260px pulls the sentinel clearly out of the band so
        // the next deliberate scroll to the top re-enters and fires.
        if (container.scrollTop < 260) container.scrollTop = 260;
      } else {
        // Guard: never strand the user at scrollTop 0 (no scroll events
        // fire at the boundary, so the next chunk could never trigger).
        if (container.scrollTop <= 0) container.scrollTop = 48;
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
        cachedAtBottom = false;
        return;
      }
      const bottom = container.scrollHeight - container.clientHeight;
      if (bottom - container.scrollTop > 1) {
        container.scrollTop = container.scrollHeight;
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
    snapToBottom(container);
  });
  function snapToBottom(c: HTMLDivElement): void {
    // Cancel any in-flight polling chains so we don't stack 5 chains
    // when the user types rapidly. Unified: cancel both timers.
    if (pendingPollTimer) { clearTimeout(pendingPollTimer); pendingPollTimer = null; }
    if (pinnedResnapTimer) { clearTimeout(pinnedResnapTimer); pinnedResnapTimer = null; }
    // Force-layout: flushSync guarantees the DOM is up to date after
    // the renderStart assignment. Without this, scrollHeight is stale.
    flushSync();
    const msgs = untrack(() => processedMessages);
    if (msgs.length > 0) {
      renderStart = Math.max(0, msgs.length - BATCH_SIZE);
    }
    flushSync();
    // Double-set with layout reflow: reading scrollHeight after writing
    // scrollTop forces a synchronous reflow so the second set uses the
    // true clamped position — no small gap.
    c.scrollTop = c.scrollHeight;
    void c.scrollHeight;
    c.scrollTop = c.scrollHeight;
    cachedAtBottom = true;
    // Single short polling chain (3 × 200ms). If a newer nonce arrives
    // mid-chain, the next snapToBottom call cancels and restarts.
    let polls = 0;
    function poll(): void {
      if (!container) return;
      const msgs2 = untrack(() => processedMessages);
      if (msgs2.length > 0) {
        renderStart = Math.max(0, msgs2.length - BATCH_SIZE);
      }
      container.scrollTop = container.scrollHeight;
      void container.scrollHeight;
      container.scrollTop = container.scrollHeight;
      cachedAtBottom = true;
      polls++;
      if (polls < 3) {
        pendingPollTimer = setTimeout(poll, 200);
      } else {
        pendingPollTimer = null;
      }
    }
    // Start the polling chain from a rAF so the initial scroll has time
    // to paint before the first poll.
    requestAnimationFrame(() => {
      // Avoid double-scroll if the user typed another message during the
      // rAF interval — the new snapToBottom already cleared this timer.
      if (!pendingPollTimer) pendingPollTimer = setTimeout(poll, 200);
    });
  }

  // indicator appears below, stealing flex space), snap back to bottom
  // if the user was pinned there — otherwise they see the viewport drift
  // up with no scroll event to correct it.
  $effect(() => {
    if (isServerBuffer) return;
    const el = container;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      if (!container) return;
      if (!cachedAtBottom) return;
      // Don't use stale prevScrollTop — RO fires async after programmatic
      // snaps; the last scroll event's prevScrollTop is stale. Just check
      // live distance from bottom per ChatInfinite.anchorFromBottom.
      const scrollHeight = container.scrollHeight;
      const offsetHeight = container.clientHeight;
      const scrollPos = Math.ceil(container.scrollTop);
      const bottom = (scrollHeight - offsetHeight) + 1;
      if ((bottom - scrollPos) > 1) {
        container.scrollTop = scrollHeight;
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  });

  $effect(() => {
    const key = bufferKey;
    const msgs = processedMessages;
    const isNewBuffer = key !== lastBufferKey;
    if (isNewBuffer) {
      pendingInitialSnap = true;
      lastBufferKey = key;
      cachedAtBottom = true;
      wasRecentlyAtBottom = true;
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
      renderStart = Math.max(0, msgs.length - BATCH_SIZE);
      renderEndKey = '';
      clockTs = null;
      lastFirstProcessedKey = msgs.length ? itemKeyOf(msgs[0]) : '';
    } else {
      const firstKey = msgs.length ? itemKeyOf(msgs[0]) : '';
      if (firstKey !== lastFirstProcessedKey) {
        if (lastFirstProcessedKey === '') {
          // Buffer content arrived (initial history load): window the tail.
          renderStart = Math.max(0, msgs.length - BATCH_SIZE);
          // Cold-start: messages arrived after the buffer was already active
          // but empty (first URL load, no cache). The initial mount's
          // pendingInitialSnap was already consumed for the empty state, so
          // force a new one to ensure we land at the very bottom.
          pendingInitialSnap = true;
          cachedAtBottom = true;
          cachedAtTop = false;
        } else {
          const oldScrollHeight = container ? container.scrollHeight : 0;
          const oldScrollTop = container ? container.scrollTop : 0;
          const atTopBefore = container ? container.scrollTop <= 0 : false;
          const scrollBottomBefore = container ? container.clientHeight + Math.ceil(container.scrollTop) : 0;
          const pinBottomBefore = container ? container.scrollHeight - scrollBottomBefore <= 1 : false;
          const idx = msgs.findIndex(m => itemKeyOf(m) === lastFirstProcessedKey);
          if (pendingInitialSnap) {
            // Still in the initial snap window (first URL load). Keep the
            // window pinned to the tail so we stay at the very bottom when
            // loadHistory prepends the remaining backlog right after the
            // initial sync. Without this, the idx>0 path would keep the
            // viewport anchored mid-history (Super%20Nets first load).
            renderStart = Math.max(0, msgs.length - BATCH_SIZE);
          } else if (idx > 0) {
            if (start > 0) renderStart = start + idx;
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
            flushSync();
            const delta = container.scrollHeight - oldScrollHeight;
            if (delta !== 0) {
              container.scrollTop = oldScrollTop + delta;
            }
          }
        }
        lastFirstProcessedKey = firstKey;
      }
    }

    if (!container) return;
    const mark = backlogDividerMark;
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
    const shouldSnapToBottom = !isServerBuffer && hasMessagesForInitialSnap && (cachedAtBottom || isInitialSnap);

    if (shouldSnapToBottom) {
      // For an initial buffer open we force the snap unconditionally —
      // do not run the scrolledUp direction check that would otherwise
      // clear the stick when scrollHeight grew under a pinned viewport.
      if (!isInitialSnap) {
        const scrolledUp = container ? container.scrollTop < prevScrollTop : false;
        if (scrolledUp) { cachedAtBottom = false; } else {
        // Ensure trim has been applied to the DOM before measuring
        // scrollHeight. Without this, renderStart may have just been moved
        // (trimming 150 rows at top) but the DOM still contains the old
        // rows, so scrollHeight is stale and the snap lands half-cut.
        flushSync();
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
              // Only animate the head of each sameAuthor group (plus
              // non-grouped rows like system messages). We walk backwards
              // from the end, so the FIRST row we encounter (closest to
              // bottom) is a candidate. Subsequent rows get the entrance
              // class only if they start a new group.
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

      // IRCCloud scrollToBottom: snap to bottom when pinned.
      // Always snap when cachedAtBottom, even if already at bottom, to
      // ensure small status rows like "is away: Auto-away" are fully
      // visible. Use flushSync above so scrollHeight reflects the trimmed
      // DOM, then double-set with reflow and a rAF for late layout
      // (images, entrance animation, font loading) which can otherwise
      // leave the new row half-cut.
      container.scrollTop = container.scrollHeight;
      void container.scrollHeight;
      container.scrollTop = container.scrollHeight;
      cachedAtTop = false;
      // One more rAF to catch any height that settles after paint
      // (e.g. image decode, entrance transform). Only if still pinned.
      requestAnimationFrame(() => {
        if (cachedAtBottom && container) {
          container.scrollTop = container.scrollHeight;
        }
      });
      // Then keep re-snapping briefly while pinned — late layout (the
      // entrance animation, embed decode, sync-driven realname spans)
      // can land well after the rAF above.
      schedulePinnedResnap();
      }
      } else {
        // Initial snap for a freshly-opened buffer (refresh): unconditional.
        maybeTrim();
        flushSync();
        const allMsgs2 = processedMessages;
        if (allMsgs2.length > 0) {
          const lastKey2 = itemKeyOf(allMsgs2[allMsgs2.length - 1]);
          if (lastKey2 !== lastBottomKey) {
            lastBottomKey = lastKey2;
          }
        }
        // Double-set with layout reflow, then rAF + resnap chain.
        // Use rAF to ensure the container has been laid out (clientHeight
        // > 0) after the isBootLoading → ChatArea mount transition.
        // Without this, a synchronous snap can land at scrollTop 0 when
        // the flex container hasn't been sized yet, leaving the user
        // stranded mid-history after a refresh.
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
          schedulePinnedResnap(25);
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
      // shows the divider at -31, not a flash of the very-top with all new
      // rows before the rAF fires. Mirrors IRCCloud's immediate scrollTo(a-31)
      // inside fetched() and matches revealBacklogFromMemory's sync path.
      const divider = container.querySelector('.backlogDivider') as HTMLElement | null;
      if (!divider) {
        // Guard: never strand the user at scrollTop 0 — no scroll events
        // fire at the boundary, so the next batch could never trigger.
        if (container.scrollTop <= 0) container.scrollTop = 48;
      } else {
        // Same as revealBacklogFromMemory: keep the browser's native
        // anchoring position (no divider-snap override — that shifted the
        // user's content down and read as "reset me back down"), only
        // enforce the 260px band-exit floor for tiny chunks.
        if (container.scrollTop < 260) container.scrollTop = 260;
      }
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
    const scrolledUp = scrollTop < prevTop;
    const heightChangedWithoutScroll = scrollHeight !== prevHeight && scrollTop === prevTop;
    const atBottom = scrolledUp
      ? false
      : cachedAtBottom
        ? heightChangedWithoutScroll ? true : distFromBottom <= 1
        : distFromBottom <= STICK_BAND_PX;
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
        }
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
        // IRCCloud bufferMessage: while scrolled up, new messages buffer
        // instead of rendering — freeze the window's end where it is now.
        const all = processedMessages;
        renderEndKey = all.length ? itemKeyOf(all[all.length - 1]) : '';
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
      if (!cachedAtBottom) return;
      cachedAtBottom = false;
      if (pendingPollTimer) { clearTimeout(pendingPollTimer); pendingPollTimer = null; }
      if (pinnedResnapTimer) { clearTimeout(pinnedResnapTimer); pinnedResnapTimer = null; }
    };
    const onWheel = (e: WheelEvent) => { if (e.deltaY < 0) clearStickOnUserInput(); };
    const onPointerDown = () => clearStickOnUserInput();
    const onKeyDown = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || (t as HTMLElement).isContentEditable)) return;
      if (SCROLL_KEYS.has(e.key)) clearStickOnUserInput();
    };
    el.addEventListener('scroll', handleScroll, { passive: true });
    el.addEventListener('wheel', onWheel, { passive: true });
    el.addEventListener('pointerdown', onPointerDown, { passive: true });
    window.addEventListener('keydown', onKeyDown, { capture: true });
    return () => {
      el.removeEventListener('scroll', handleScroll);
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown, { capture: true } as EventListenerOptions);
    };
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
    // svelte-ignore non_reactive_update
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

    {#if messagesWithDates.length === 0 && !isServerBuffer}
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
  }
  .messages {
    overflow-y: auto;
    overflow-x: hidden;
    flex: 1;
    scroll-behavior: auto;
    overscroll-behavior: contain;
    scrollbar-gutter: stable;
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
  .empty-channel {
    margin: auto;
    padding: 64px 24px;
    text-align: center;
    color: #8b949e;
    pointer-events: none;
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
</style>
