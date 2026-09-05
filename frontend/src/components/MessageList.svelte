<script lang="ts">
  import { untrack, flushSync, tick, onMount, onDestroy } from 'svelte';
  import { ircState, isMessageUnseen, getActiveBufferObj, getActiveNetwork, countMessagesBetween, countImportantMessagesBetween, clearUnseenHighlightsAfter, unseenHighlightCountAfter, updateBottomSeen, setBacklogDivider, getTypersForBuffer, readBuffer, isImportantMessage, isSelfMessage, isSessionFocused, getVisitSeen, clearVisitSeen, isMessageUnseenForVisit, getVisitSeenMessage } from '../stores/ircStore.svelte';
  import { getClearedAt, getBufferPrefs, getFocusSeen, getBottomSeen, getLastSeen, clearBottomSeen, setBottomSeen, ignoreList } from '../stores/preferences.svelte';
  import { isMessageIgnored } from '../lib/ignorePolicy';
  import { preprocessMessages } from '../lib/messageBuilder';
  import MessageRow from './MessageRow.svelte';
  import DateChange from './DateChange.svelte';
  import ServerLog from './ServerLog.svelte';

  import SeenDivider from './SeenDivider.svelte';
  import ChatterBar from './ChatterBar.svelte';
  import ScrollClock from './ScrollClock.svelte';
  import { handleChannelLinkClick } from '../lib/channelLinks';
  import { isSkippedCommand, getMsgDate, formatDate, formatDateTimeTitle, formatShortRelativeTime, stringHash, stripPrefix, stripHash, normalizeChannelName } from '../lib/utils';
  import { perfMark, perfMeasure } from '../lib/perf';
  import { dividerPos as sharedDividerPos, animateScrollTo, cancelScrollAnimation } from '../lib/scroll';
  import type { IRCMessage, Member, Network } from '../types';

  interface Props {
    onNickClick?: (nick: string, event: MouseEvent, member?: any | null) => void;
    onLoadMore?: () => Promise<boolean>;
  }
  let { onNickClick, onLoadMore }: Props = $props();

  let container = $state(null) as HTMLDivElement | null;

  // ── IRCCloud BufferScrollView state (kiyR) ──
  // `scrolledToBottom` is cached from the last scroll event so a content
  // change can decide to pin from the pre-change position; the DOM is only
  // re-read inside doScroll.
  let cachedAtBottom = $state(true);
  let wasRecentlyAtBottom = true;
  let recentlyScrolledTimeout: ReturnType<typeof setTimeout> | null = null;
  let lastScrollTop = 0;
  let lastScrollHeight = 0;
  let resizing = false;
  let resizingTimeout: ReturnType<typeof setTimeout> | null = null;
  let batchRendering = false;

  // IRCCloud upper/lower chatter (9lob / wNhE). `true` count = more than
  // 100 messages ("<time> of unread messages").
  let aboveVisible = $state(false);
  let aboveCount = $state<number | true>(0);
  let aboveTime = $state<number | null>(null);
  let aboveMentions = $state(0);
  let belowVisible = $state(false);
  let belowCount = $state<number | true>(0);
  let belowTime = $state<number | null>(null);
  let belowMentions = $state(0);

  let stickyNick = $state('');
  let stickyColor = $state('');
  let stickyMode = $state('');
  // Direct DOM ref to the sticky avatar container — IRCCloud does
  // `this.stickyAvatarContainer.css({ top: top })` (jQuery, synchronous,
  // no framework reactivity). We mirror that with a direct style write
  // here so the `top` updates on every scroll event feel just as snappy
  // and aren't queued behind a Svelte microtask.
  let stickyAvatarEl = $state<HTMLDivElement | null>(null);

  // IRCCloud ScrollClockView: timestamp of the message at the top of the
  // scroll; null hides the clock (at bottom / no upper message).
  let clockTs = $state<number | null>(null);

  // MUST fold the same way every store write does (`setMessages`,
  // `appendMessage`, … all key through `normalizeChannelName`). Channels
  // arrive here already normalized, but a query/DM keeps the counterparty's
  // display case in `activeBuffer` on purpose — so a raw key like
  // `<net>:EliManning` never matched the stored `<net>:elimanning`,
  // `hasHistoryLoaded` stayed false and the DM sat on "Loading history…"
  // forever with its messages in the store the whole time. Any nick that is
  // not already lower-case was affected.
  const bufferKey = $derived(`${ircState.activeBuffer.networkId}:${normalizeChannelName(ircState.activeBuffer.bufferName ?? '')}`);
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
  // the server-log classifier doesn't understand.
  // Return the original array reference without spreading: a spread
  // would create a new array on every store mutation, even when a
  // different buffer's messages changed (e.g. a channel PRIVMSG while
  // viewing _server), and re-render the whole log. With reference
  // identity, downstream deriveds only re-run when the _server array
  // itself is reassigned (new message for _server).
  const rawMessages = $derived(ircState.messages[bufferKey] ?? []);

  // _server buffers render the flat ServerLog view instead of the
  // message-row view. See frontend/src/lib/serverLogRows.ts.
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

  // IRCCloud: `div.messageRow.ignored { display:none }` in channel/server/
  // thread views only — DM conversations keep the rows and show a header
  // banner instead (BufferHeader). Reading `ignoreList.length` subscribes
  // this derived to the list, so /ignore retro-hides rendered history and
  // /unignore reveals it live (IRCCloud's `ignoresChange` retoggle).
  function filterIgnored(messages: IRCMessage[]): IRCMessage[] {
    if (messages.length === 0 || ignoreList.length === 0) return messages;
    const buf = getActiveBufferObj();
    if (buf?.type === 'query') return messages;
    return messages.filter(m => !isMessageIgnored(m));
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
        const ignoredFiltered = filterIgnored(awayFiltered);
        const skippedFiltered = ignoredFiltered.filter(m => !isSkippedCommand(m.command));
        perfMeasure(`processedMessages len=${skippedFiltered.length} (cache hit)`, t0);
        return skippedFiltered;
      }
      const filtered = cached.filter(m => (m.t || 0) > clearedAt);
      const jpFiltered = filterJoinPart(filtered);
      const awayFiltered = filterAway(jpFiltered);
      const ignoredFiltered = filterIgnored(awayFiltered);
      const skippedFiltered = ignoredFiltered.filter(m => !isSkippedCommand(m.command));
      perfMeasure(`processedMessages len=${skippedFiltered.length} (cache hit, cleared)`, t0);
      return skippedFiltered;
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
    const ignoredFiltered = filterIgnored(awayFiltered);
    const skippedFiltered = ignoredFiltered.filter(m => !isSkippedCommand(m.command));
    perfMeasure(`processedMessages len=${skippedFiltered.length} (cold)`, t0);
    return skippedFiltered;
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
    const lastTs = getVisitSeen(nid, buf);
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
  //   - scroll-to-top reveals the previous 200 from memory instantly
  //     (loadOrRenderBacklog → messages.filterBeforeEid(first, batchSize));
  //     the network is only hit when memory is fully rendered
  //   - while pinned at the bottom, the DOM is trimmed back to 200 rows
  //     once more than 350 trimmable rows are rendered (checkTrim,
  //     trimDetectThreshold=350, trimThreshold=200)
  const BATCH_SIZE = 200;
  const TRIM_DETECT_THRESHOLD = 350;
  const TRIM_THRESHOLD = 200;
  let renderStart = $state(0);
  // IRCCloud BufferLogView.lastSeenEid — track the eid for which the
  // "New messages" divider was last rendered, per buffer, to avoid
  // duplicate dividers for the same eid on re-render. Plain object, not
  // $state, to allow mutation during render without triggering reactivity.
  let lastSeenEidMap: Record<string, string | number> = {};

  // IRCCloud BufferLogView.bufferMessage/checkFlush: while the user is
  // scrolled up reading, incoming messages are buffered and the DOM is NOT
  // touched — they flush when the user returns to the bottom. We freeze the
  // window's end at the last rendered message when leaving the bottom.
  let renderEndKey = $state('');

  function itemKeyOf(msg: IRCMessage): string {
    if (msg.label) return `l:${msg.label}`;
    if (msg.eid != null) return `e:${msg.eid}`;
    return msg.msgid || `t:${msg.t}`;
  }

  const processedIndexByKey = $derived.by(() => {
    const m = new Map<string, number>();
    processedMessages.forEach((msg, i) => {
      const k = itemKeyOf(msg);
      if (!m.has(k)) m.set(k, i);
    });
    return m;
  });

  // ── Backlog fetch state (IRCCloud loadBacklog / fetched / fetchFailed) ──
  let fetching = false;
  // Last ChatArea.handleLoadMore result: true until a fetch returns false.
  let hasMoreHistory = $state(true);
  let showFetchRow = $state(false);
  let showFetchFailedRow = $state(false);
  let showLoadMoreRow = $state(false);
  let windowRevealInProgress = false;
  // Wall-clock time bottomSeen was locked (IRCCloud bottomSeen row
  // `data-locked-time`) — the lower chatter shows this until it advances.
  let bottomSeenLockedAt = 0;

  // ── IRCCloud scroll predicates ──
  function isScrolledToBottom(): boolean {
    if (!container) return true;
    return container.scrollHeight - (container.offsetHeight + Math.ceil(container.scrollTop)) <= 1;
  }
  function isScrolledToTop(): boolean {
    return !!container && container.scrollTop === 0;
  }
  function setScrolledToBottom(v: boolean): void {
    if (cachedAtBottom !== v) cachedAtBottom = v;
    if (v) {
      wasRecentlyAtBottom = true;
      if (recentlyScrolledTimeout) { clearTimeout(recentlyScrolledTimeout); recentlyScrolledTimeout = null; }
    } else if (!recentlyScrolledTimeout) {
      recentlyScrolledTimeout = setTimeout(() => {
        wasRecentlyAtBottom = false;
        recentlyScrolledTimeout = null;
      }, 100);
    }
  }
  // Only for window resize / composer autogrow (IRCCloud checkRecent:true).
  function shouldPinBottom(): boolean {
    return isScrolledToBottom() || wasRecentlyAtBottom;
  }

  // IRCCloud scrollTo(y, {animate, silent}): animated → jQuery animate
  // (duration 100, swing) with onScroll() on complete; else direct set +
  // synchronous onScroll(false) unless silent.
  function scrollTo(y: number, opts: { animate?: boolean; silent?: boolean; afterAnimate?: () => void } = {}): void {
    if (!container) return;
    if (opts.animate) {
      animateScrollTo(container, y, 100, () => {
        opts.afterAnimate?.();
        onScroll(false);
      }, setResizing);
      return;
    }
    container.scrollTop = y;
    if (opts.silent) {
      // Silent: no doScroll, but record the position so the native scroll
      // event this write produces is deduped and the next user scroll is
      // still detected as a change.
      lastScrollTop = container.scrollTop;
      lastScrollHeight = container.scrollHeight;
      return;
    }
    onScroll(false);
  }

  export function scrollToBottom(opts: { silent?: boolean } = {}): void {
    if (!container) return;
    setScrolledToBottom(true);
    const t = Math.ceil(container.scrollTop);
    const s = container.scrollHeight - container.offsetHeight + 1;
    if (s - t > 1) scrollTo(s, { silent: opts.silent });
  }

  export function scrollToTop(): void {
    scrollTo(0);
  }

  // IRCCloud onScroll: ignore while resizing; dedupe no-op events.
  function onScroll(userScrolled = false): void {
    if (!container || resizing || batchRendering) return;
    const { scrollTop, scrollHeight } = container;
    if (scrollTop === lastScrollTop && scrollHeight === lastScrollHeight) return;
    lastScrollTop = scrollTop;
    lastScrollHeight = scrollHeight;
    doScroll(userScrolled);
  }

  // IRCCloud setResizing: suppress scroll handling for 100 ms after the
  // last resize/animation frame, then re-evaluate once.
  function setResizing(): void {
    resizing = true;
    if (resizingTimeout) clearTimeout(resizingTimeout);
    resizingTimeout = setTimeout(() => {
      resizingTimeout = null;
      resizing = false;
      if (container) {
        lastScrollTop = container.scrollTop;
        lastScrollHeight = container.scrollHeight;
      }
      doScroll(false);
    }, 100);
  }

  function lockBottomSeen(): void {
    const { networkId, bufferName } = ircState.activeBuffer;
    if (!networkId || !bufferName || bufferName === '_server') return;
    if (getBottomSeen(networkId, bufferName) !== null) return;
    const list = ircState.messages[`${networkId}:${normalizeChannelName(bufferName)}`] ?? [];
    const last = list[list.length - 1];
    if (!last?.t) return;
    setBottomSeen(networkId, bufferName, last.t);
    const buf = getActiveBufferObj();
    if (buf) buf.bottomSeen = last.t;
    bottomSeenLockedAt = Date.now();
  }

  function unlockBottomSeen(): boolean {
    const { networkId, bufferName } = ircState.activeBuffer;
    if (!networkId || !bufferName) return false;
    const had = getBottomSeen(networkId, bufferName) !== null;
    if (had) {
      clearBottomSeen(networkId, bufferName);
      const buf = getActiveBufferObj();
      if (buf) buf.bottomSeen = null;
    }
    return had;
  }

  // IRCCloud buffer view doScroll: runs after every (deduped) scroll event.
  function doScroll(userScrolled: boolean): void {
    if (!container) return;
    let atBottom = isScrolledToBottom();
    if (atBottom) {
      // IRCCloud flushBuffer → onChange(true): the newly rendered rows grow
      // the content, so re-pin to the true bottom.
      if (flushLiveBuffer()) scrollToBottom({ silent: true });
      // bottomSeen existed → the divider is being dismissed by this scroll;
      // IRCCloud reports atBottom=false to the read trigger for this pass.
      if (unlockBottomSeen()) atBottom = false;
    } else {
      lockBottomSeen();
      // IRCCloud bufferMessage: while scrolled up, incoming messages are
      // buffered instead of rendered — freeze the window's end here.
      if (untrack(() => renderEndKey) === '') {
        const all = processedMessages;
        if (all.length) renderEndKey = itemKeyOf(all[all.length - 1]);
      }
    }
    setScrolledToBottom(isScrolledToBottom());
    onScrollChange(atBottom, userScrolled);
    checkInfiniscroll();
  }

  // IRCCloud BufferScrollView.onChange(e): after any content change decide
  // whether to pin; bottomSeen (scrolled-up divider) always wins.
  function onChange(e?: boolean): void {
    if (!container || batchRendering) return;
    const { networkId, bufferName } = ircState.activeBuffer;
    if (networkId && bufferName && getBottomSeen(networkId, bufferName) !== null) e = false;
    else if (e === undefined) e = cachedAtBottom;
    if (e) scrollToBottom({ silent: true });
    onScrollChange(!!e, false);
    checkInfiniscroll();
  }

  // ── Infiniscroll (IRCCloud checkInfiniscroll / loadOrRenderBacklog) ──
  function isFullyRendered(): boolean {
    return untrack(() => renderStart) === 0 && !hasMoreHistory;
  }

  function checkInfiniscroll(): void {
    if (isServerBuffer) return;
    if (isScrolledToBottom() || isFullyRendered() || !isScrolledToTop()) return;
    loadOrRenderBacklog();
  }

  function loadOrRenderBacklog(): void {
    if (untrack(() => renderStart) > 0) revealBacklogFromMemory();
    else loadBacklog();
  }

  // IRCCloud loadBacklog: render the fetch row, then hit the model after
  // 200 ms so a scroll-wheel burst at the top only fires one request.
  function loadBacklog(): void {
    if (fetching || !onLoadMore || !hasHistoryLoaded) return;
    fetching = true;
    showFetchRow = true;
    showLoadMoreRow = false;
    showFetchFailedRow = false;
    const key = bufferKey;
    setTimeout(async () => {
      if (key !== bufferKey) { fetching = false; showFetchRow = false; return; }
      const atTop = isScrolledToTop();
      const atBottom = isScrolledToBottom();
      let ok: boolean;
      try {
        ok = await onLoadMore();
      } catch {
        fetchFailed();
        return;
      }
      if (key !== bufferKey) { fetching = false; showFetchRow = false; return; }
      hasMoreHistory = ok;
      showFetchRow = false;
      await tick();
      fetched(atTop, atBottom);
    }, 200);
  }

  // IRCCloud loadOrRenderBacklog in-memory path: reveal the previous batch
  // synchronously inside the scroll event (parking the user at scrollTop 0
  // would wedge infiniscroll: the browser fires no further scroll events).
  function revealBacklogFromMemory(): boolean {
    const start = untrack(() => renderStart);
    if (start <= 0 || !container) return false;
    const atTop = isScrolledToTop();
    const atBottom = isScrolledToBottom();
    const boundary = processedMessages[start];
    if (boundary && ircState.activeBuffer.networkId && ircState.activeBuffer.bufferName) {
      setBacklogDivider(ircState.activeBuffer.networkId, ircState.activeBuffer.bufferName, itemKeyOf(boundary));
    }
    windowRevealInProgress = true;
    renderStart = Math.max(0, start - BATCH_SIZE);
    flushSync();
    windowRevealInProgress = false;
    fetched(atTop, atBottom);
    return true;
  }

  // IRCCloud fetched(e, t, i): place the viewport after a prepend.
  //   not at top before → pin only if it was at bottom (browser anchoring
  //   keeps the reading position otherwise); at bottom → pin; at top →
  //   jump to divider-31 then animate to max(divider-152, 48) and settle.
  function fetched(atTop: boolean, atBottom: boolean): void {
    showLoadMoreRow = !isFullyRendered();
    if (!container) { fetchDone(false); return; }
    const divider = container.querySelector('.backlogDivider') as HTMLElement | null;
    if (!atTop) { fetchDone(atBottom); return; }
    if (atBottom) { fetchDone(true); return; }
    if (!divider) { fetchDone(false); return; }
    const a = Math.round(dividerPos(divider));
    container.scrollTop = a - 31;
    lastScrollTop = container.scrollTop;
    lastScrollHeight = container.scrollHeight;
    animateScrollTo(container, Math.max(a - 152, 48), 100, () => {
      if (!container) return;
      const e = Math.round(dividerPos(divider));
      container.scrollTop = Math.max(e - 152, 48);
      lastScrollTop = container.scrollTop;
      lastScrollHeight = container.scrollHeight;
      fetchDone(false);
    }, setResizing);
  }

  function fetchDone(pin: boolean): void {
    fetching = false;
    onChange(pin);
  }

  function fetchFailed(): void {
    fetching = false;
    showFetchRow = false;
    showLoadMoreRow = true;
    showFetchFailedRow = true;
  }

  // IRCCloud clickLoadMore.
  function clickLoadMore(): void {
    if (!container) return;
    container.scrollTop = 0;
    lastScrollTop = 0;
    lastScrollHeight = container.scrollHeight;
    setScrolledToBottom(false);
    loadOrRenderBacklog();
  }

  // IRCCloud checkTrim(force): only important/self rows count; above 350
  // of them (while at bottom, or forced) trim so the last 200 remain,
  // never cutting above the row currently at the top of the viewport.
  function checkTrim(force: boolean): void {
    const net = activeNetwork;
    if (!net) return;
    const all = processedMessages;
    const start = untrack(() => renderStart);
    const trimmable: number[] = [];
    for (let i = start; i < all.length; i++) {
      const m = all[i];
      if (isImportantMessage(m, net) || isSelfMessage(m, net)) trimmable.push(i);
    }
    if (trimmable.length <= TRIM_DETECT_THRESHOLD) return;
    if (!force && !cachedAtBottom) return;
    let target = trimmable[trimmable.length - TRIM_THRESHOLD];
    if (container) {
      const topRow = probeRow(container.getBoundingClientRect(), 'top');
      const topIdx = topRow ? (processedIndexByKey.get(rowKeyOf(topRow)) ?? -1) : -1;
      if (topIdx >= 0 && topIdx < target) target = topIdx;
    }
    if (target > start) renderStart = target;
  }

  // IRCCloud flushBuffer at bottom: render everything buffered while the
  // user was scrolled up. More than 350 buffered → only the last 200
  // render (messageBufferTrim).
  function flushLiveBuffer(): boolean {
    const frozen = untrack(() => renderEndKey);
    if (!frozen) return false;
    const all = processedMessages;
    let endIdx = -1;
    for (let i = all.length - 1; i >= 0; i--) {
      if (itemKeyOf(all[i]) === frozen) { endIdx = i; break; }
    }
    const buffered = endIdx >= 0 ? all.length - endIdx - 1 : 0;
    batchRendering = true;
    renderEndKey = '';
    if (buffered > TRIM_DETECT_THRESHOLD) renderStart = Math.max(0, all.length - TRIM_THRESHOLD);
    else checkTrim(false);
    try { flushSync(); } catch {}
    batchRendering = false;
    return buffered > 0;
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
    const keyCounts = new Map<string, number>();
    return msgs.map((msg, i) => {
      const msgDate = getMsgDate(msg);
      const prevMsg = i > 0 ? msgs[i - 1] : null;
      const prevDate = prevMsg ? getMsgDate(prevMsg) : null;
      const showDate = !!(msgDate && msgDate !== prevDate && msgDate !== lastDate);
      if (showDate) lastDate = msgDate;
      const showBacklogDivider = !dividerPlaced && dividerMark !== '' && i > 0 &&
        itemKeyOf(msg) === dividerMark;
      if (showBacklogDivider) dividerPlaced = true;
      // The key is the message identity; only genuine collisions (msgid-less
      // rows sharing a timestamp) get an occurrence suffix. Keys must NOT
      // depend on the row's index: a history prepend would re-key every
      // row, Svelte would recreate the DOM, and the browser's scroll
      // anchoring would lose the row it was holding in place.
      const base = itemKeyOf(msg);
      const seen = keyCounts.get(base) ?? 0;
      keyCounts.set(base, seen + 1);
      return { msg, showDate, msgDate, prevDate, prevMsg, showBacklogDivider, _key: seen === 0 ? base : `${base}#${seen}` };
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
    // Visit pin: opening the buffer already advanced the real read marker,
    // so the "new messages" line has to come from where this visit started.
    const lastTs = getVisitSeen(nid, buf);
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
  // messages change, never during scroll events. Keyed by both the
  // {#each} item key and the DOM row key (`data-msgid` / `t:<time>`) so a
  // probed row resolves to its message whichever id it carries.
  function rowKeyOfMsg(msg: IRCMessage): string {
    return msg.msgid || `t:${msg.t}`;
  }
  const renderedIndexByKey = $derived.by(() => {
    const m = new Map<string, number>();
    messagesWithDates.forEach((item, i) => {
      const k = itemKeyOf(item.msg);
      if (!m.has(k)) m.set(k, i);
      const rk = rowKeyOfMsg(item.msg);
      if (!m.has(rk)) m.set(rk, i);
    });
    return m;
  });

  const rawMessageByKey = $derived.by(() => {
    const m = new Map<string, IRCMessage>();
    for (const msg of ircState.messages[bufferKey] ?? []) {
      const k = itemKeyOf(msg);
      if (!m.has(k)) m.set(k, msg);
      const rk = rowKeyOfMsg(msg);
      if (!m.has(rk)) m.set(rk, msg);
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

  let lastBufferKey = '';
  let lastFirstProcessedKey = '';
  let lastProcessedLength = 0;

  // Divider position in scroll-content coordinates (jQuery .position().top
  // equivalent for the scroll container).
  function dividerPos(divider: HTMLElement): number {
    if (!container) return 0;
    return sharedDividerPos(container, divider);
  }

  // ── Message entrance animation ───────────────────────────────────────
  // Only the batch head (firstAuthor rows or non-grouped messages) gets
  // the slide-in; same-author continuations get a subtler fade.
  let entranceKeys = $state(new Set<string>());
  let lastBottomKey = '';

  function markEntrance(allMsgs: IRCMessage[]): void {
    if (allMsgs.length === 0) return;
    const lastKey = itemKeyOf(allMsgs[allMsgs.length - 1]);
    if (lastKey === lastBottomKey) return;
    if (lastBottomKey) {
      let foundBoundary = false;
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
        setTimeout(() => { entranceKeys = new Set(); }, 150);
      }
    }
    lastBottomKey = lastKey;
  }

  // Force-scroll trigger: when the user sends a message, InputArea
  // increments forceScrollToBottomNonce. IRCCloud always shows you your
  // own message after Enter, even if you had scrolled up.
  let lastForceScrollNonce = 0;
  $effect(() => {
    const nonce = ircState.forceScrollToBottomNonce;
    if (nonce === lastForceScrollNonce) return;
    lastForceScrollNonce = nonce;
    if (!container) return;
    untrack(() => {
      renderEndKey = '';
      const msgs = processedMessages;
      if (msgs.length > 0) renderStart = Math.max(0, msgs.length - BATCH_SIZE);
      try { flushSync(); } catch {}
      unlockBottomSeen();
      scrollToBottom();
      onScroll(false);
    });
  });

  // Viewport/content resize (IRCCloud window resize + autogrowInput with
  // checkRecent, and image/embed decode): re-pin while pinned.
  $effect(() => {
    const el = container;
    if (!el) return;
    // Window resize (IRCCloud @538661): suppress scroll handling while
    // the browser re-lays out, then re-pin with checkRecent.
    const onWindowResize = () => { const pin = shouldPinBottom(); setResizing(); onChange(pin); };
    // Container size change (composer autogrow / typing row — IRCCloud
    // autogrowInput checkPinBottom({checkRecent:true})): re-pin only.
    let lastHeight = el.clientHeight;
    const onContainerResize = () => {
      if (el.clientHeight === lastHeight) return;
      lastHeight = el.clientHeight;
      onChange(shouldPinBottom());
    };
    const onContentGrowth = () => onChange(untrack(() => cachedAtBottom));
    const ro = new ResizeObserver(onContainerResize);
    ro.observe(el);
    const embedRo = new ResizeObserver(onContentGrowth);
    const observeEmbeds = () => {
      el.querySelectorAll('.directEmbedWrap, .editor').forEach((n) => {
        try { embedRo.observe(n as Element); } catch {}
      });
    };
    // Late layout growth inside an already-rendered row (image decode,
    // embed expansion, inline style changes) while pinned: re-pin once.
    const mo = new MutationObserver((records) => {
      observeEmbeds();
      if (records.some(r => r.type === 'attributes')) onContentGrowth();
    });
    mo.observe(el, { childList: true, subtree: true, attributes: true, attributeFilter: ['style'] });
    observeEmbeds();
    el.addEventListener('load', onContentGrowth, true);
    el.addEventListener('error', onContentGrowth, true);
    window.addEventListener('resize', onWindowResize);
    return () => {
      window.removeEventListener('resize', onWindowResize);
      el.removeEventListener('load', onContentGrowth, true);
      el.removeEventListener('error', onContentGrowth, true);
      mo.disconnect();
      embedRo.disconnect();
      ro.disconnect();
    };
  });

  // Typing indicator row shrinks the viewport (it lives outside the
  // observed container) — same re-pin rule as the composer autogrow.
  const isTypingActive = $derived.by(() => {
    void ircState.typingVersion;
    const netId = ircState.activeBuffer.networkId;
    const buf = ircState.activeBuffer.bufferName;
    if (!netId || !buf) return false;
    return getTypersForBuffer(netId, buf).length > 0;
  });
  $effect(() => {
    void isTypingActive;
    if (!container) return;
    untrack(() => { const pin = shouldPinBottom(); tick().then(() => onChange(pin)); });
  });

  // ── Windowing effect ──────────────────────────────────────────────────
  // Sole writer of renderStart/renderEndKey during normal message flow.
  // Only bufferKey, processedMessages and container are tracked; every
  // other signal is read through untrack so a write never re-queues the
  // effect (frontend/scripts/check-effect-loops.mjs guards this).
  $effect(() => {
    if (windowRevealInProgress) return;
    const key = bufferKey;
    const msgs = processedMessages;
    void container;
    untrack(() => {
      if (key !== lastBufferKey) {
        // IRCCloud select(): render the last batchSize=200 and scroll to bottom.
        lastBufferKey = key;
        renderStart = Math.max(0, msgs.length - BATCH_SIZE);
        renderEndKey = '';
        hasMoreHistory = true;
        fetching = false;
        showFetchRow = false;
        showFetchFailedRow = false;
        showLoadMoreRow = msgs.length > 0;
        clockTs = null;
        lastBottomKey = msgs.length ? itemKeyOf(msgs[msgs.length - 1]) : '';
        lastFirstProcessedKey = msgs.length ? itemKeyOf(msgs[0]) : '';
        lastProcessedLength = msgs.length;
        setScrolledToBottom(true);
        tick().then(() => {
          if (!container || bufferKey !== key) return;
          scrollToBottom({ silent: true });
          lastScrollTop = container.scrollTop;
          lastScrollHeight = container.scrollHeight;
          doScroll(false);
        });
        return;
      }
      const firstKey = msgs.length ? itemKeyOf(msgs[0]) : '';
      if (firstKey !== lastFirstProcessedKey) {
        if (lastFirstProcessedKey === '') {
          // Initial history arrival for an open buffer: window the tail
          // and land at the bottom (IRCCloud initial backlog render).
          renderStart = Math.max(0, msgs.length - BATCH_SIZE);
          renderEndKey = '';
          hasMoreHistory = true;
          showLoadMoreRow = true;
          lastBottomKey = itemKeyOf(msgs[msgs.length - 1]);
          setScrolledToBottom(true);
          tick().then(() => {
            if (!container || bufferKey !== key) return;
            scrollToBottom({ silent: true });
            lastScrollTop = container.scrollTop;
            lastScrollHeight = container.scrollHeight;
            doScroll(false);
          });
        } else {
          // Older history prepended: keep the window on the same rows.
          const idx = msgs.findIndex(m => itemKeyOf(m) === lastFirstProcessedKey);
          const start = renderStart;
          if (idx > 0 && start > 0) renderStart = start + idx;
          // Placement: our own fetch runs fetched() from loadBacklog; a
          // prepend from elsewhere (CHATHISTORY backfill) applies the same
          // rule from the last observed scroll position.
          if (!fetching) {
            const atTop = lastScrollTop === 0;
            const atBottom = cachedAtBottom;
            tick().then(() => { if (bufferKey === key) fetched(atTop, atBottom); });
          }
        }
      } else if (msgs.length !== lastProcessedLength) {
        // Live append (IRCCloud flushBuffer): while pinned the rows
        // render now and the DOM is trimmed; while scrolled up they stay
        // buffered behind renderEndKey and only the chatter updates.
        if (cachedAtBottom && renderEndKey === '') {
          markEntrance(msgs);
          checkTrim(false);
        } else if (!cachedAtBottom && renderEndKey === '' && lastProcessedLength > 0 && msgs.length > lastProcessedLength) {
          // Scrolled up but no scroll event froze the window yet — freeze
          // at the last row that was already rendered.
          renderEndKey = itemKeyOf(msgs[lastProcessedLength - 1]);
        }
        tick().then(() => { if (bufferKey === key) onChange(); });
      } else {
        // In-place replacement (optimistic echo swap, edit): same rule.
        tick().then(() => { if (bufferKey === key) onChange(); });
      }
      lastFirstProcessedKey = firstKey;
      lastProcessedLength = msgs.length;
    });
  });

  // Passive scroll listener (Svelte's onscroll compiles non-passive).
  $effect(() => {
    const el = container;
    if (!el) return;
    const handler = () => onScroll(true);
    el.addEventListener('scroll', handler, { passive: true });
    return () => el.removeEventListener('scroll', handler);
  });

  onMount(() => {
    ircState.scrollChangeHook = (userScrolled: boolean) => {
      if (!container) return;
      onScrollChange(isScrolledToBottom(), userScrolled);
    };
  });
  onDestroy(() => {
    ircState.scrollChangeHook = null;
    if (resizingTimeout) clearTimeout(resizingTimeout);
    if (recentlyScrolledTimeout) clearTimeout(recentlyScrolledTimeout);
    cancelScrollAnimation();
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

  function rowMessage(row: HTMLElement | null): IRCMessage | null {
    if (!row) return null;
    return rawMessageByKey.get(rowKeyOf(row)) ?? null;
  }

  // IRCCloud upperChatter.update(m) (9lob): returns null (no row), true
  // (bar shown) or false (hidden — the caller may mark the buffer read).
  function upperUpdate(m: IRCMessage | null): boolean | null {
    const { networkId, bufferName } = ircState.activeBuffer;
    if (!m || !networkId || !bufferName) return null;
    // Measured against the visit pin, not the live marker: opening the
    // buffer marks it read, and the bar still has to say what was unread
    // when the user arrived.
    if (isMessageUnseenForVisit(m, networkId, bufferName)) {
      aboveMentions = clearUnseenHighlightsAfter(networkId, bufferName, m.t ?? 0);
      const visitSeen = getVisitSeen(networkId, bufferName);
      if (visitSeen !== null) {
        const n = getVisitSeenMessage(networkId, bufferName);
        const show = !n || countMessagesBetween(networkId, bufferName, n, m) > 100 || countImportantMessagesBetween(networkId, bufferName, n, m) > 0;
        if (show) {
          aboveCount = true;
          aboveTime = visitSeen;
          aboveVisible = true;
          return true;
        }
      }
    }
    aboveVisible = false;
    aboveCount = 0;
    aboveTime = null;
    return false;
  }

  // IRCCloud lowerChatter.update(m, bottomSeenRow) (wNhE).
  function lowerUpdate(m: IRCMessage | null): boolean {
    const { networkId, bufferName } = ircState.activeBuffer;
    if (!m || !networkId || !bufferName) return false;
    const advanced = updateBottomSeen(networkId, bufferName, m.t ?? 0);
    const n = getBottomSeen(networkId, bufferName);
    if (n === null) {
      belowVisible = false;
      belowCount = 0;
      belowMentions = 0;
      belowTime = null;
      return false;
    }
    belowMentions = unseenHighlightCountAfter(networkId, bufferName, n);
    const list = ircState.messages[`${networkId}:${normalizeChannelName(bufferName)}`] ?? [];
    let nMsg: IRCMessage | null = null;
    for (let i = list.length - 1; i >= 0; i--) {
      if ((list[i].t ?? 0) <= n) { nMsg = list[i]; break; }
    }
    const count: number | true = countMessagesBetween(networkId, bufferName, nMsg) > 100 ? true : countImportantMessagesBetween(networkId, bufferName, nMsg);
    belowTime = !advanced && bottomSeenLockedAt ? bottomSeenLockedAt : Date.now();
    belowCount = count;
    belowVisible = count === true || count > 0 || belowMentions > 0;
    return advanced;
  }

  function rowElementFor(msg: IRCMessage): HTMLElement | null {
    if (!container) return null;
    const rows = container.querySelectorAll<HTMLElement>('.row.messageRow');
    const key = rowKeyOfMsg(msg);
    for (const r of rows) if (rowKeyOf(r) === key) return r;
    return null;
  }

  // IRCCloud buffer view onScrollChange(atBottom, userScrolled): the read
  // trigger. Runs after every scroll event and content change.
  function onScrollChange(atBottom: boolean, userScrolled: boolean): void {
    if (!container || isServerBuffer) return;
    const rect = container.getBoundingClientRect();
    const topRow = probeRow(rect, 'top');
    let bottomRow = probeRow(rect, 'bottom');
    if (bottomRow && bottomRow.getBoundingClientRect().bottom > rect.bottom + 1) {
      // Last FULLY visible row (IRCCloud getRowAtBottomOfScroll).
      let prev = bottomRow.previousElementSibling as HTMLElement | null;
      while (prev && !prev.classList.contains('messageRow')) prev = prev.previousElementSibling as HTMLElement | null;
      if (prev) bottomRow = prev;
    }
    if (!fetching) {
      const { networkId, bufferName } = ircState.activeBuffer;
      const top = rowMessage(topRow);
      // The bar reports against the VISIT pin (what was unread when the
      // user arrived) and may stay up for the whole visit…
      upperUpdate(top);
      // …but the read trigger must gate on the LIVE marker, exactly like
      // IRCCloud (`!1===upperChatter.update(n)&&(userScrolled||focused)&&
      // read()` — their update() measures last_seen_eid, not a pin).
      // Gating on the pin froze the marker after a large influx: the bar
      // never cleared while its territory was on screen, so readBuffer
      // never ran, and messages that landed after the open-time mark
      // ("N unread") could only be cleared by scrolling the backlog.
      // "Top row is seen" = the user is not reading old unread territory,
      // so everything below (through the bottomSeen/focusSeen caps in
      // readBuffer) is fair game to mark.
      const topUnseenLive = top && networkId && bufferName
        ? isMessageUnseen(top, networkId, bufferName) : null;
      if (topUnseenLive === false && (userScrolled || isSessionFocused()) && networkId && bufferName) {
        readBuffer(networkId, bufferName);
      }
      lowerUpdate(rowMessage(bottomRow));
    }
    updateStickyAvatar(topRow, rect);
    updateScrollClock(topRow);
    void atBottom;
  }

  // Upper bar click: scroll to the last-read message if rendered, else
  // page in more backlog (IRCCloud upperChatter click).
  function onUpperClick(): void {
    if (!container) return;
    const { networkId, bufferName } = ircState.activeBuffer;
    // Jump to where the visit started, which is what the bar is reporting.
    const lastSeenMsg = networkId && bufferName ? getVisitSeenMessage(networkId, bufferName) : null;
    const key = lastSeenMsg ? itemKeyOf(lastSeenMsg) : '';
    const idx = key ? (renderedIndexByKey.get(key) ?? -1) : -1;
    if (idx >= 0) {
      const row = rowElementFor(messagesWithDates[idx].msg);
      scrollTo(row ? Math.max(0, dividerPos(row) - 48) : 0, { animate: true });
      return;
    }
    scrollToTop();
    setScrolledToBottom(false);
    loadOrRenderBacklog();
  }

  function onUpperDismiss(): void {
    const { networkId, bufferName } = ircState.activeBuffer;
    if (networkId && bufferName) {
      // Dismissing is an explicit "I'm done with what was unread": drop the
      // visit pin so the bar and the divider go away for good.
      clearVisitSeen(networkId, bufferName);
      readBuffer(networkId, bufferName);
    }
    onScrollChange(isScrolledToBottom(), false);
  }

  // Lower bar click: render buffered messages, then jump to the
  // bottomSeen divider (alt → very bottom).
  function onLowerClick(e?: MouseEvent): void {
    if (!container) return;
    flushLiveBuffer();
    const { networkId, bufferName } = ircState.activeBuffer;
    const n = networkId && bufferName ? getBottomSeen(networkId, bufferName) : null;
    if (!e?.altKey && n !== null) {
      const divider = container.querySelector('.row.seenDivider.bottomSeen') as HTMLElement | null;
      if (divider) {
        scrollTo(Math.max(0, dividerPos(divider) - 48), { animate: true });
        return;
      }
    }
    scrollToBottom();
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
</script>

{#if aboveVisible}
  <ChatterBar position="above" count={aboveCount === true ? 101 : aboveCount} timestamp={aboveTime} mentions={aboveMentions} onClick={onUpperClick} onDismiss={onUpperDismiss} />
{/if}

<div class="messages-viewport" class:clockShown={clockTs !== null}>
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div class="messages" id="messages" bind:this={container}
       onclick={(e) => handleChannelLinkClick(e)}>
    {#if !isServerBuffer && hasHistoryLoaded}
      {#if showFetchRow}
        <div class="row fetch" class:initialFetch={processedMessages.length === 0} role="status" aria-label="Loading history">
          <hr />
          <h4 class="divider-text-wrapper"><span class="divider-text">{processedMessages.length === 0 ? 'Fetching history…' : 'Fetching more history…'}</span></h4>
        </div>
      {/if}
      {#if showFetchFailedRow}
        <div class="row fetch fetchFailed" role="alert">
          <hr />
          <h4 class="divider-text-wrapper"><span class="divider-text">Fetching failed</span></h4>
        </div>
      {/if}
      {#if showLoadMoreRow && !showFetchRow}
        <div class="row loadMore"><button class="loadMore__button" tabindex="-1" type="button" onclick={clickLoadMore}><span>Load more backlog…</span></button></div>
      {/if}
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
      <!-- Server log view: flat IRCCloud-style connection log. Same
           scroll container so the IRCCloud onChange pin (only when
           already at bottom) applies to the log exactly like chat. -->
      <ServerLog messages={rawMessages} network={activeNetwork} />
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

{#if belowVisible}
  <ChatterBar position="below" count={belowCount === true ? 101 : belowCount} timestamp={belowTime} mentions={belowMentions} onClick={onLowerClick} />
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
  /* IRCCloud .clockShown: original IRCCloud pads loadMore/fetch by 30px so
     the floating clock doesn't cover them. That padding changes
     scrollHeight by 30px, which toggles distFromBottom across the
     cachedAtBottom exit threshold (4px) and flickers the clock when
     scrolling down into the 70px stick band (60→30→60 loop). Fiber's
     ScrollClock is pointer-events:none and overlays without needing
     layout push — keep it non-affecting. */
  .backlogDivider {
    margin: 0;
    contain: layout paint;
    content-visibility: auto;
    contain-intrinsic-size: 0 21px;
  }
  .backlogDivider hr {
    margin: 20px 0;
    border: none;
    border-top: 1px solid #4d8ccb;
    contain: layout paint;
  }
  :global(body.theme-midnight) .backlogDivider hr,
  :global(.backlogDivider) hr {
    border-top-color: #4d4d4d;
  }
  :global(body.theme-dusk) .backlogDivider hr {
    border-top-color: #4d8ccb;
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
  /* IRCCloud .row.loadMore: "Load more backlog…" button at the top of the
     log whenever older history exists and no fetch is in flight. */
  .row.loadMore {
    text-align: center;
    padding: 6px 0;
    margin: 0;
  }
  .row.loadMore .loadMore__button {
    background: none;
    border: none;
    color: var(--accent, #1e72ff);
    font-size: 12px;
    cursor: pointer;
    padding: 2px 8px;
  }
  .row.loadMore .loadMore__button:hover { text-decoration: underline; }
  /* IRCCloud fetch divider — from common-002a6024.css / common-5650bddb.js
     div.log div.fetch hr{margin:20px 0; border-color:#8c8c8c (midnight) / #4d8ccb (dusk)}
     .divider-text-wrapper{float:left;width:100%;height:15px;margin-top:-30px;line-height:15px;font-size:14px;text-align:center}
     span{padding:0 10px;background-color:#000;color:#8c8c8c} */
  .row.fetch {
    margin: 0;
    user-select: none;
  }
  .row.fetch hr {
    border: none;
    border-top: 1px solid #8c8c8c;
    margin: 20px 0;
  }
  .row.fetch .divider-text-wrapper {
    float: left;
    width: 100%;
    height: 15px;
    margin-top: -30px;
    line-height: 15px;
    font-size: 14px;
    text-align: center;
  }
  .row.fetch .divider-text {
    padding: 0 10px;
    background-color: var(--chat-bg, #000);
    color: #8c8c8c;
  }
  .row.fetch.initialFetch {
    padding-top: 0;
  }
  :global(body.theme-dusk) .row.fetch hr {
    border-color: #4d8ccb;
  }
  :global(body.theme-dusk) .row.fetch .divider-text {
    background-color: #11263b;
    color: #4d8ccb;
  }
  :global(body.theme-midnight) .row.fetch hr {
    border-color: #8c8c8c;
  }
  :global(body.theme-midnight) .row.fetch .divider-text {
    background-color: #000;
    color: #8c8c8c;
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
