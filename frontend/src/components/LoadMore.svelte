<script lang="ts">
  import { onMount } from 'svelte';
  import { getClearedAt, clearClearedAt } from '../stores/preferences.svelte';
  import { ircState } from '../stores/ircStore.svelte';

  interface Props {
    onLoadMore?: () => Promise<boolean>;
  }
  let { onLoadMore }: Props = $props();

  let sentinel: HTMLDivElement;
  let loading = $state(false);
  let hasMore = $state<boolean | null>(null);
  let scrollEl: HTMLElement | null = null;

  const bufferKey = $derived(`${ircState.activeBuffer.networkId}:${ircState.activeBuffer.bufferName}`);
  const messageCount = $derived((ircState.messages[bufferKey] ?? []).length);

  const clearedAt = $derived.by(() => {
    if (!ircState.activeBuffer.networkId || !ircState.activeBuffer.bufferName) return null;
    return getClearedAt(ircState.activeBuffer.networkId, ircState.activeBuffer.bufferName);
  });

  // Reset on buffer change
  $effect(() => {
    void bufferKey;
    hasMore = null;
  });

  // When messages first arrive, check if we should load more history
  $effect(() => {
    if (messageCount > 0 && hasMore === null && !clearedAt && onLoadMore) {
      queueMicrotask(() => onScroll());
    }
  });

  function handleClick(): void {
    if (clearedAt) {
      clearClearedAt(ircState.activeBuffer.networkId!, ircState.activeBuffer.bufferName!);
      return;
    }
  }

  async function tryAutoLoad(): Promise<void> {
    if (loading || clearedAt || !onLoadMore) return;
    loading = true;
    try {
      const more = await onLoadMore();
      hasMore = more ? true : false;
    } finally {
      loading = false;
    }
  }

  function onScroll(): void {
    if (!scrollEl || !onLoadMore || loading || clearedAt || hasMore === false) return;
    // When scrolled within 200px of the top, load more history
    if (scrollEl.scrollTop <= 200) {
      tryAutoLoad().catch(() => {});
    }
  }

  onMount(() => {
    if (!onLoadMore) return;
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
      <span>{loading ? 'Loading…' : 'Load more backlog…'}</span>
    </button>
  </div>
{/if}
<div class="loadMoreSentinel" bind:this={sentinel}></div>

<style>
  .loadMoreSentinel {
    min-height: 1px;
  }
</style>
