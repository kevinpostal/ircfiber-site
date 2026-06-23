<script lang="ts">
  import { onMount } from 'svelte';
  import { getClearedAt, clearClearedAt } from '../stores/preferences.svelte';
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
  let noMoreHistory = $state(false);
  // $state so the viewport-fill effect re-runs once onMount assigns it.
  let scrollEl = $state<HTMLElement | null>(null);
  let consecutiveEmptyLoads = 0;
  const MAX_EMPTY_RETRIES = 5;

  const bufferKey = $derived(`${ircState.activeBuffer.networkId}:${ircState.activeBuffer.bufferName}`);
  const messageCount = $derived((ircState.messages[bufferKey] ?? []).length);

  const clearedAt = $derived.by(() => {
    if (!ircState.activeBuffer.networkId || !ircState.activeBuffer.bufferName) return null;
    return getClearedAt(ircState.activeBuffer.networkId, ircState.activeBuffer.bufferName);
  });

  // Reset per-buffer state on buffer switch (IRCCloud re-renders the log
  // fresh on select). No initial auto-fetch: IRCCloud only renders the
  // cached backlog plus the "Load more backlog…" button; infiniscroll
  // fires when the user scrolls to the very top.
  let checkedBufferKey = '';
  let lastOldestKey = '';
  $effect(() => {
    const key = bufferKey;
    if (key !== checkedBufferKey) {
      checkedBufferKey = key;
      noMoreHistory = false;
      fetchFailed = false;
      consecutiveEmptyLoads = 0;
      lastOldestKey = '';
      lastFillAttemptCount = -1;
      lastFillScrollHeight = -1;
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
  $effect(() => {
    const count = messageCount;
    void loading;
    void noMoreHistory;
    void ircState.backlogDivider[bufferKey]; // advances on memory reveals
    if (!scrollEl || loading || clearedAt || noMoreHistory) return;
    if (!onLoadMore && !onRevealFromMemory) return;
    if (count === 0) return;
    requestAnimationFrame(() => {
      if (!scrollEl || loading || noMoreHistory || clearedAt) return;
      if (scrollEl.scrollHeight > scrollEl.clientHeight + 1) return; // already scrollable
      if (messageCount === lastFillAttemptCount && scrollEl.scrollHeight === lastFillScrollHeight) {
        return; // no progress — stop
      }
      lastFillAttemptCount = messageCount;
      lastFillScrollHeight = scrollEl.scrollHeight;
      tryAutoLoad().catch((e) => console.error('[LoadMore] fill error:', e));
    });
  });

  function sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
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

  // IRCCloud BufferScrollView.checkInfiniscroll: fire only when scrolled
  // to the very top (scrollTop === 0), not already at the bottom (short
  // buffers don't infiniscroll), and there's still history to load.
  function onScroll(): void {
    if (!scrollEl || loading || clearedAt || noMoreHistory) return;
    if (!onLoadMore && !onRevealFromMemory) return;
    if (scrollEl.scrollTop > 0) return;
    const scrollBottom = scrollEl.clientHeight + Math.ceil(scrollEl.scrollTop);
    if (scrollEl.scrollHeight - scrollBottom <= 1) return;
    tryAutoLoad().catch((e) => console.error('[LoadMore] tryAutoLoad error:', e));
  }

  // IRCCloud BufferScrollView.clickLoadMore: scroll to top, then load.
  function handleClick(): void {
    if (clearedAt) {
      clearClearedAt(ircState.activeBuffer.networkId!, ircState.activeBuffer.bufferName!);
      return;
    }
    scrollEl?.scrollTo({ top: 0 });
    tryAutoLoad().catch((e) => console.error('[LoadMore] tryAutoLoad error:', e));
  }

  onMount(() => {
    if (!onLoadMore && !onRevealFromMemory) return;
    const el = document.getElementById('messages');
    if (!el) return;
    scrollEl = el;
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      el.removeEventListener('scroll', onScroll);
    };
  });
</script>

{#if clearedAt}
  <div class="row loadMore">
    <button class="loadMore__button" type="button" tabindex="-1" onclick={handleClick}>
      <span>Load more backlog…</span>
    </button>
  </div>
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
