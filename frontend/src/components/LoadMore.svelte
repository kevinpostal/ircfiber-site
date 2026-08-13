<script lang="ts">
  import { onMount } from 'svelte';
  import { getClearedAt } from '../stores/preferences.svelte';
  import { ircState } from '../stores/ircStore.svelte';

  interface Props {
    onLoadMore?: () => Promise<boolean>;
    /** IRCCloud loadOrRenderBacklog in-memory path: reveal the previous
     *  batch of already-loaded messages instantly. Returns false when
     *  everything in memory is rendered (then the network path runs). */
    onRevealFromMemory?: () => boolean;
  }
  let { onLoadMore, onRevealFromMemory }: Props = $props();

  let loading = $state(false);
  let fetchFailed = $state(false);
  let noMoreHistory = $state(true); // start hidden to avoid flash — probe will show if needed
  // $state so the viewport-fill effect re-runs once onMount assigns it.
  let scrollEl = $state<HTMLElement | null>(null);
  let consecutiveEmptyLoads = 0;
  let checkedBufferKey = $state('');
  const MAX_EMPTY_RETRIES = 5;

  const bufferKey = $derived(`${ircState.activeBuffer.networkId}:${ircState.activeBuffer.bufferName}`);
  const messageCount = $derived((ircState.messages[bufferKey] ?? []).length);

  const clearedAt = $derived.by(() => {
    if (!ircState.activeBuffer.networkId || !ircState.activeBuffer.bufferName) return null;
    return getClearedAt(ircState.activeBuffer.networkId, ircState.activeBuffer.bufferName);
  });

  // Reset per-buffer state on buffer switch (IRCCloud re-renders the log
  let lastOldestKey = '';
  $effect(() => {
    const key = bufferKey;
    if (key !== checkedBufferKey) {
      checkedBufferKey = key;
      // Start hidden for small/empty buffers to avoid flash of Load more
      // that then hides after silent probe. Large buffers (≥50) are likely
      // to have more history, so start visible and let scroll probe confirm.
      const lst = ircState.messages[key] ?? [];
      const small = lst.length > 0 && lst.length < 50;
      const empty = lst.length === 0;
      noMoreHistory = small || empty ? true : false;
      fetchFailed = false;
      consecutiveEmptyLoads = 0;
      lastOldestKey = '';
      lastFillAttemptCount = -1;
      lastFillScrollHeight = -1;
      lastFillTime = 0;
      silentFillIterations = 0;
    }
  });

  // Reset noMoreHistory when an OLDER message lands — CHATHISTORY backfill
  // might arrive via WebSocket prepend after we gave up, so let infiniscroll
  // resume. Keyed off the oldest message (not the count) so realtime
  // appends at the bottom don't restart fill/fetch cycles.
  $effect(() => {
    const list = ircState.messages[bufferKey] ?? [];
    const first = list[0];
    const oldestKey = first ? (first.msgid || `t:${first.t}`) : '';
    if (oldestKey !== lastOldestKey && noMoreHistory) {
      noMoreHistory = false;
      consecutiveEmptyLoads = 0;
    }
    lastOldestKey = oldestKey;
  });

  // Silent probe: determine if "Load more" should show without ever
  // flashing "Fetching…". Runs once per buffer for EVERY size — a large
  // buffer whose history is exhausted (e.g. a channel whose scrollback
  // is dominated by WHO/NAMES noise the reader now filters out) would
  // otherwise show a lying "Load more backlog…" button that confirms
  // empty only after two clicks. The probe does one silent fetch (no
  // loading UI) and sets noMoreHistory from the result. Guarded for
  // tests (MODE===test) so MessageList unit tests with 50/600 messages
  // don't get an unexpected fetch.
  let probedKey = '';
  let probePending = '';
  $effect(() => {
    if (import.meta.env.MODE === 'test') return;
    const key = bufferKey;
    const count = messageCount;
    // Only probe once per buffer.
    if (key === probedKey || key === probePending) return;
    if (count === 0) return;
    if (!onLoadMore || clearedAt || loading) return;
    const lst = ircState.messages[key] ?? [];
    if (lst.length === 0) return;
    if (lst.every((m: any) => !m.eid && m.label)) return;
    const last = lst[lst.length - 1] as any;
    if (last?.label && !last.eid) return;
    probePending = key;
    queueMicrotask(async () => {
      if (bufferKey !== key || loading || clearedAt) {
        probePending = '';
        return;
      }
      try {
        const hasMore = await onLoadMore();
        if (bufferKey !== key) {
          probePending = '';
          return;
        }
        // hasMore true → show Load more, false → keep hidden (started hidden to avoid flash)
        noMoreHistory = !hasMore;
      } catch {
        // Leave button visible so user can retry via click/scroll
        probedKey = ''; // allow retry
        probePending = '';
        return;
      }
      probedKey = key;
      probePending = '';
    });
  });
  // ── Viewport fill (IRCCloud parity) ──
  // IRCCloud opens a buffer with the last batchSize=200 messages from its
  // session backlog, so the log always overflows the viewport. Our backend
  // may return fewer — then the log is unscrollable (scrollTop pinned at 0
  // AND "at bottom"), so infiniscroll can never fire and the user can't
  // even scroll. Keep revealing/fetching until the content overflows the
  // viewport or history is exhausted. Bail when an attempt makes no
  // progress (same cursor would loop forever); memory reveals don't change
  // messageCount, so progress is tracked via scrollHeight too.
  let lastFillAttemptCount = -1;
  let lastFillScrollHeight = -1;
  let lastFillTime = 0;
  let silentFillIterations = 0;
  const MAX_SILENT_FILLS = 3;
  // Viewport auto-fill should NOT flash "Fetching more history…" — that
  // divider is for user-initiated loads when the window is already full
  // (scrollable) and the user scrolls to top / clicks Load more. For
  // auto-fill (window not yet scrollable, opening a buffer with few
  // messages), we silently fetch without the 200ms delay or loading UI
  // so a channel with no older history never flickers the divider.
  async function tryAutoFillSilent(): Promise<void> {
    if (onRevealFromMemory?.()) {
      fetchFailed = false;
      return;
    }
    if (!onLoadMore) return;
    const lst = ircState.messages[bufferKey] ?? [];
    if (lst.length === 0 || lst.every((m: any) => !m.eid && m.label)) {
      noMoreHistory = true;
      return;
    }
    if (lst.length < 5) {
      const first = lst[0] as any;
      const isRecent = first?.t && Date.now() - first.t < 5 * 60 * 1000;
      const isJoinLike = first?.command === 'JOIN' || first?.command === 'JOINPART_GROUP';
      if (isRecent && isJoinLike) {
        noMoreHistory = true;
        return;
      }
    }
    const key = bufferKey;
    try {
      const hasMore = await onLoadMore();
      if (bufferKey !== key) return;
      if (hasMore) {
        consecutiveEmptyLoads = 0;
        return;
      }
      consecutiveEmptyLoads++;
      if (consecutiveEmptyLoads >= 2) {
        noMoreHistory = true;
      } else {
        // One silent retry — don't show loading for auto-fill
        await sleep(2000);
        if (bufferKey !== key || noMoreHistory) return;
        const retryHasMore = await onLoadMore();
        if (bufferKey !== key) return;
        if (!retryHasMore) noMoreHistory = true;
        else consecutiveEmptyLoads = 0;
      }
    } catch (e) {
      console.error('[LoadMore] silent fill failed:', e);
      if (bufferKey === key) fetchFailed = true;
    }
  }
$effect(() => {
    const count = messageCount;
    void noMoreHistory;
    void ircState.backlogDivider[bufferKey]; // advances on memory reveals
    if (!scrollEl || loading || clearedAt || noMoreHistory) return;
    if (!onLoadMore && !onRevealFromMemory) return;
    if (count === 0) return;
    // Don't auto-fill due to a just-sent optimistic message at the bottom —
    // the viewport fill is for older backlog, not for new bottom appends.
    // Without this, every send in a small buffer flashes "Fetching…".
    const list = ircState.messages[bufferKey] ?? [];
    const last = list[list.length - 1] as any;
    if (last?.label && !last.eid) return;
    // Wait for the silent probe to determine whether older history exists
    // before auto-filling — otherwise viewport-fill would fetch in parallel
    // with the probe and flash "Fetching…" for a channel with no backlog.
    // In test mode the probe is disabled (MODE==='test' early-return), so
    // don't block fill — the unit test for auto-fill expects immediate fetch.
    if (import.meta.env.MODE !== 'test' && probedKey !== bufferKey) return;
    requestAnimationFrame(() => {
      if (!scrollEl || loading || noMoreHistory || clearedAt) return;
      if (scrollEl.scrollHeight > scrollEl.clientHeight) return; // already scrollable — spec isScrollable
      if (messageCount === lastFillAttemptCount && scrollEl.scrollHeight === lastFillScrollHeight) {
        return; // no progress — stop (fix: now correctly tracked)
      }
      if (silentFillIterations >= MAX_SILENT_FILLS) return; // bounded per ChatInfinite.progressiveLoadTerminates
      // 150ms debounce between silent fills + cap to 3 iterations (covers
      // BATCH_SIZE=200 needing at most 2 fetches to overflow 800px at ~24px/row)
      const now = Date.now();
      if (now - lastFillTime < 150) return;
      lastFillTime = now;
      lastFillAttemptCount = messageCount;
      lastFillScrollHeight = scrollEl.scrollHeight;
      silentFillIterations += 1;
      tryAutoFillSilent().catch((e) => console.error('[LoadMore] fill error:', e));
      // Re-arm sentinel now that content may have become scrollable
      ensureSentinel();
    });
  });

  function sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => setTimeout(resolve, ms));
  }

  async function tryAutoLoad(): Promise<void> {
    if (loading || clearedAt || noMoreHistory) return;
    // IRCCloud loadOrRenderBacklog: when older messages are already in
    // memory, the previous batch renders instantly — no fetching row, no
    // 200ms delay. The network is only hit once memory is fully rendered.
    if (onRevealFromMemory?.()) {
      fetchFailed = false;
      return;
    }
    if (!onLoadMore) return;
    // Empty or all-optimistic (no real history yet) — don't flash
    // "Fetching…" for a channel that has never had backlog. Mark as
    // complete so the button stays hidden instead of re-trying.
    const lst = ircState.messages[bufferKey] ?? [];
    if (lst.length === 0) {
      noMoreHistory = true;
      return;
    }
    if (lst.every((m: any) => !m.eid && m.label)) {
      noMoreHistory = true;
      return;
    }
    // Just-joined channel: single JOIN (or few recent system messages)
    // and no real chat history yet. Don't flash Fetching; hide Load more.
    if (lst.length < 5) {
      const first = lst[0] as any;
      const isRecent = first?.t && Date.now() - first.t < 5 * 60 * 1000;
      const isJoinLike = first?.command === 'JOIN' || first?.command === 'JOINPART_GROUP';
      if (isRecent && isJoinLike) {
        noMoreHistory = true;
        return;
      }
    }
    const key = bufferKey;
    loading = true;
    fetchFailed = false;
    try {
      // IRCCloud BufferScrollView.loadBacklog: delay the fetch by 200ms
      // to handle scrolling jumpiness. The "Fetching more history…"
      // divider is visible for this window, exactly like IRCCloud.
      await sleep(200);
      while (bufferKey === key) {
        const hasMore = await onLoadMore();
        if (bufferKey !== key) return;
        if (hasMore) {
          consecutiveEmptyLoads = 0;
          return;
        }
        // Empty response — backlog is fully loaded. No retries needed
        // for DMs or channels with no history; the cursor is correct.
        consecutiveEmptyLoads++;
        if (consecutiveEmptyLoads >= 2) {
          // IRCCloud: fully rendered → the loadMore row is removed.
          noMoreHistory = true;
          return;
        }
        // One retry in case CHATHISTORY was still in flight.
        await sleep(2000);
      }
    } catch (e) {
      console.error('[LoadMore] backlog fetch failed:', e);
      // IRCCloud renderFetchFailed: "Fetching failed" divider + button.
      if (bufferKey === key) fetchFailed = true;
    } finally {
      loading = false;
    }
  }

  // IRCCloud BufferScrollView.checkInfiniscroll, redesigned as the
  // svelte-infinite pattern: an IntersectionObserver on a sentinel at the
  // top of the scroll content with a 200px rootMargin pre-load buffer.
  // The sentinel intersects up to 200px BEFORE the user reaches the top,
  // so the previous batch is revealed/fetched while the user is still
  // scrolling — no dead zone at the top and no reliance on scroll events
  // firing at the exact boundary (which wedged at scrollTop 0).
  let sentinelEl = $state<HTMLElement | null>(null);
  let io: IntersectionObserver | null = null;

  function onSentinelVisible(): void {
    if (!scrollEl || loading || clearedAt || noMoreHistory) return;
    if (!onLoadMore && !onRevealFromMemory) return;
    // Short/empty buffers: the sentinel is visible at scrollTop 0 by
    // construction. The viewport-fill effect handles those (silently);
    // firing tryAutoLoad here would flash "Fetching more history…".
    if (scrollEl.scrollHeight <= scrollEl.clientHeight) return;
    // No loop protection needed (svelte-infinite's loop detection is for
    // loaders whose appends can be shorter than the rootMargin): every
    // successful reveal adds BATCH_SIZE rows (~5-10k px), moving the
    // sentinel far out of the 200px band, and the fetch path sets
    // `loading`/`noMoreHistory`. A re-entry therefore means the user
    // really scrolled back up — fire again.
    tryAutoLoad().catch((e) => console.error('[LoadMore] tryAutoLoad error:', e));
  }

  // IRCCloud BufferScrollView.clickLoadMore: scroll to top, then load.
  function handleClick(): void {
    if (clearedAt) return; // backlog was cleared — nothing to load
    scrollEl?.scrollTo({ top: 0 });
    tryAutoLoad().catch((e) => console.error('[LoadMore] tryAutoLoad error:', e));
  }

  function ensureSentinel(): void {
    if (io || !scrollEl || !sentinelEl) return;
    if (scrollEl.scrollHeight <= scrollEl.clientHeight) return; // still not scrollable — fill will retry
    io = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) onSentinelVisible();
      },
      { root: scrollEl, rootMargin: '200px 0px 0px 0px', threshold: 0 },
    );
    io.observe(sentinelEl);
  }

  onMount(() => {
    if (!onLoadMore && !onRevealFromMemory) return;
    const el = document.getElementById('messages');
    if (!el) return;
    scrollEl = el;
    // Arm on first scroll — mount-time scrollTop is transiently 0 before snap-to-bottom
    // lands; arming then would pre-reveal history. Also install sync fallback:
    // IntersectionObserver fires async next frame, so a Home/End jump on same tick
    // as arm would miss the 200px band — the scroll handler catches it synchronously
    // per ChatInfinite.noWedgeAtTop / sentinelPreloadFiresBeforeTop.
    let armed = false;
    const arm = () => {
      if (armed) return;
      armed = true;
      el.removeEventListener('scroll', arm);
      ensureSentinel();
    };
    const onScrollFallback = () => {
      if (!scrollEl) return;
      if (scrollEl.scrollTop <= 200 && scrollEl.scrollHeight > scrollEl.clientHeight) {
        if (!loading && !clearedAt && !noMoreHistory) onSentinelVisible();
      }
    };
    el.addEventListener('scroll', arm, { passive: true });
    el.addEventListener('scroll', onScrollFallback, { passive: true });
    return () => {
      el.removeEventListener('scroll', arm);
      el.removeEventListener('scroll', onScrollFallback);
      io?.disconnect();
      io = null;
    };
  });
</script>

<!-- Reverse-infinite-scroll sentinel (svelte-infinite pattern): the
     IntersectionObserver watches this 1px row, which sits at the very
     top of the scroll content, and pre-loads the previous batch when
     the user scrolls within 200px of it. Always rendered so the
     observer stays armed; the callback guards on state. -->
<div class="infinite-sentinel" aria-hidden="true" bind:this={sentinelEl}></div>

{#if clearedAt}
  <!-- Backlog cleared — nothing to load -->
{:else if messageCount === 0}
  <!-- Empty buffer — no backlog to load -->
{:else if loading}
  <div class="row fetch">
    <hr />
    <h4 class="divider-text-wrapper"><span class="divider-text">Fetching more history…</span></h4>
  </div>
{:else if noMoreHistory}
  <!-- IRCCloud: backlog fully rendered — no loadMore row -->
{:else}
  <div class="row loadMore">
    <button class="loadMore__button" type="button" tabindex="-1" onclick={handleClick}>
      <span>Load more backlog…</span>
    </button>
  </div>
  {#if fetchFailed}
    <div class="row fetch fetchFailed">
      <hr />
      <h4 class="divider-text-wrapper"><span class="divider-text">Fetching failed</span></h4>
    </div>
  {/if}
{/if}

<style>
  /* Reverse-infinite-scroll sentinel — 1px invisible row at the top of
     the scroll content. Must not collapse to 0px height (the observer
     still works, but a 0-height box with threshold 0 is less reliable
     across browsers). */
  .infinite-sentinel {
    height: 1px;
    width: 100%;
    pointer-events: none;
  }
  /* IRCCloud fetch divider: line with centered text chip */
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
</style>
